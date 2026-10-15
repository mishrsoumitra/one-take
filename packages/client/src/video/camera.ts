/**
 * The camera: opens it for the live picture on the stage, and, while the microphone is on, encodes
 * its frames on the microphone's clock so each phrase can take the stretch of picture that goes
 * with its audio.
 *
 * The microphone hands the app one block of audio every 10 ms, and every phrase knows which blocks
 * it is made of (`Phrase.at`). The camera does not know about phrases; it only needs two things from
 * whoever drives the microphone: `tick(seen, keepFrom)` after every block, which tells it what time
 * it is (so many blocks have gone by) and how far back frames may still be wanted, and
 * `take(fromMs, toMs)` when a phrase is stored, which cuts the frames for that stretch out of what
 * it has kept. Frames are stamped with the block clock as they arrive, less the few tens of
 * milliseconds a camera frame takes longer than the sound of the same moment to reach the page.
 *
 * Frames are encoded as they come (H.264 when the browser has it, else VP8) at a modest size and
 * rate, with a key frame every second, and kept as encoded chunks: a minute of picture is a few
 * megabytes, so a phrase of any length can be held until its second listen is done. Everything before
 * the key frame at or before `keepFrom` is let go of on every tick.
 *
 * Frames come from `MediaStreamTrackProcessor` where the browser has it (they keep coming when the
 * tab is in the background), otherwise from the live `<video>` element's frame callbacks.
 */
import { pieceFromFrames, US, type ClipVideo, type EncodedFrame } from '../core/clip-video.js';

/** The picture is stored this tall; the width follows the camera's own shape. */
const CAPTURE_HEIGHT = 360;
const CAPTURE_FPS = 24;
const CAPTURE_KBPS = 500;
/** A key frame at least this often, so a phrase never has to decode more than this to reach its start. */
const KEY_EVERY_US = US;
/**
 * A camera frame reaches the page later than the sound of the same moment reaches the audio thread:
 * the sensor, the driver and the browser's pipeline add a few tens of milliseconds that a microphone
 * does not have. Frames are stamped this much earlier than they arrive.
 */
const CAMERA_LAG_MS = 40;
/** Frames are let go of in runs, not one at a time. */
const PRUNE_BATCH = 48;

/** Codecs tried in order; the first the browser can encode wins. Annex B H.264 needs no out-of-band description. */
const CODECS: readonly { codec: string; avc?: AvcEncoderConfig }[] = [
  { codec: 'avc1.42E01F', avc: { format: 'annexb' } },
  { codec: 'vp8' },
];

export interface CameraInfo {
  label: string;
  width: number;
  height: number;
  codec: string;
}

export type CameraState = 'off' | 'opening' | 'on' | 'error';

export interface CameraCallbacks {
  /** The camera opened, closed or failed; `error` carries the reason. */
  onState: (state: CameraState, error?: string) => void;
}

interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>;
}

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike;

function trackProcessor(): TrackProcessorCtor | null {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null;
}

/** One stretch of recording: the block clock and the frames kept on it. */
interface Session {
  blockMs: number;
  /** Blocks the microphone has delivered so far, and when the last one arrived. */
  seen: number;
  tickAt: number;
  /** Still taking frames (false once paused: what is kept stays until the session ends). */
  encoding: boolean;
  frames: EncodedFrame[];
  lastUs: number;
  lastKeyUs: number;
  count: number;
}

export class CameraCapture {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private _state: CameraState = 'off';
  private _info: CameraInfo | null = null;
  private encoder: VideoEncoder | null = null;
  private codec: string | null = null;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private session: Session | null = null;
  /** Bumped by every open and close, so a late frame or chunk from an earlier camera is ignored. */
  private generation = 0;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private fallbackVideo: HTMLVideoElement | null = null;
  private fallbackHandle = 0;

  constructor(private readonly callbacks: CameraCallbacks) {}

  /** Whether this browser can record the camera: WebCodecs plus a way to read frames off the track. */
  static supported(): boolean {
    return (
      typeof VideoEncoder !== 'undefined' &&
      typeof VideoDecoder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'mediaDevices' in navigator &&
      (trackProcessor() !== null || 'requestVideoFrameCallback' in HTMLVideoElement.prototype)
    );
  }

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default');
    } catch {
      return [];
    }
  }

  get state(): CameraState {
    return this._state;
  }

  get on(): boolean {
    return this._state === 'on';
  }

  /** The live stream, for a `<video>` element to show. */
  get liveStream(): MediaStream | null {
    return this.stream;
  }

  get info(): CameraInfo | null {
    return this._info;
  }

  /** Width over height of the picture as stored. */
  get aspect(): number {
    return this._info ? this._info.width / this._info.height : 16 / 9;
  }

  /** Frames are being kept for phrases right now. */
  get recording(): boolean {
    return this.session !== null;
  }

  /** Bytes of encoded picture held for phrases not yet stored. */
  get heldBytes(): number {
    let n = 0;
    if (this.session) for (const f of this.session.frames) n += f.data.byteLength;
    return n;
  }

  /**
   * Opens the camera. `fallbackVideo` is the element that shows the live picture; it is where frames
   * are read from in browsers without `MediaStreamTrackProcessor`.
   */
  async open(deviceId: string | undefined, fallbackVideo: HTMLVideoElement): Promise<boolean> {
    this.close();
    const gen = ++this.generation;
    this.setState('opening');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
    } catch (error) {
      if (gen === this.generation) this.setState('error', describeError(error));
      return false;
    }
    if (gen !== this.generation) {
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      this.setState('error', 'The camera gave no picture.');
      return false;
    }
    const settings = track.getSettings();
    const srcW = settings.width ?? 1280;
    const srcH = settings.height ?? 720;
    const height = CAPTURE_HEIGHT;
    const width = Math.max(2, Math.round((height * srcW) / srcH / 2) * 2);
    const codec = await pickCodec(width, height);
    if (gen !== this.generation) {
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    if (!codec) {
      for (const t of stream.getTracks()) t.stop();
      this.setState('error', 'This browser cannot encode camera video.');
      return false;
    }
    this.stream = stream;
    this.track = track;
    this.codec = codec.codec;
    this._info = { label: track.label || 'Camera', width, height, codec: codec.codec };
    this.makeCanvas(width, height);
    track.addEventListener('ended', () => {
      if (gen === this.generation) {
        this.close();
        this.setState('error', 'The camera was disconnected.');
      }
    });
    this.fallbackVideo = fallbackVideo;
    this.startFrames(gen);
    this.setState('on');
    return true;
  }

  close(): void {
    this.generation++;
    this.stopRecording();
    this.stopFrames();
    this.encoder = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.track = null;
    this._info = null;
    if (this._state !== 'off') this.setState('off');
  }

  /* ---------------------------------------------------------------- recording */

  /** The microphone started: frames are kept from now on, on a clock of `blockMs` blocks. */
  record(blockMs: number): void {
    this.stopRecording();
    if (!this.on || !this.codec || !this._info) return;
    this.session = {
      blockMs,
      seen: 0,
      tickAt: performance.now(),
      encoding: true,
      frames: [],
      lastUs: -1,
      lastKeyUs: -Infinity,
      count: 0,
    };
    this.configureEncoder();
  }

  /** The microphone delivered a block: `seen` blocks so far; nothing before block `keepFrom` is wanted any more. */
  tick(seen: number, keepFrom: number): void {
    const s = this.session;
    if (!s) return;
    s.seen = seen;
    s.tickAt = performance.now();
    this.prune(Math.max(0, keepFrom) * s.blockMs * 1000);
  }

  /** The microphone stopped: no more frames, but what is kept stays until `stopRecording()`. */
  pause(): void {
    const s = this.session;
    if (!s?.encoding) return;
    s.encoding = false;
    void this.encoder?.flush().catch(() => undefined);
  }

  /** The last phrase of this recording is stored: let everything go. */
  stopRecording(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (this.encoder?.state === 'configured') {
      try {
        this.encoder.close();
      } catch {
        /* already closed */
      }
    }
    this.encoder = null;
  }

  /** The picture for the stretch of microphone time `[fromMs, toMs)`, or null when the camera has none of it. */
  take(fromMs: number, toMs: number): ClipVideo | null {
    const s = this.session;
    const info = this._info;
    if (!s || !info || !this.codec) return null;
    const piece = pieceFromFrames(s.frames, Math.round(fromMs * 1000), Math.round(toMs * 1000));
    if (!piece) return null;
    return { codec: this.codec, width: info.width, height: info.height, pieces: [piece] };
  }

  /* ---------------------------------------------------------------- frames in */

  private startFrames(gen: number): void {
    const track = this.track;
    if (!track) return;
    const Processor = trackProcessor();
    if (Processor) {
      let reader: ReadableStreamDefaultReader<VideoFrame>;
      try {
        reader = new Processor({ track }).readable.getReader();
      } catch (error) {
        console.warn('MediaStreamTrackProcessor failed; reading frames from the video element', error);
        this.startFallbackFrames(gen);
        return;
      }
      this.reader = reader;
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || gen !== this.generation) {
              value?.close();
              break;
            }
            try {
              this.frameIn(value, value.displayWidth, value.displayHeight);
            } finally {
              value.close();
            }
          }
        } catch {
          /* the track ended or the reader was released */
        }
      })();
      return;
    }
    this.startFallbackFrames(gen);
  }

  /** Browsers without a track processor: one callback per frame the live `<video>` shows. */
  private startFallbackFrames(gen: number): void {
    const video = this.fallbackVideo;
    if (!video) return;
    const loop = () => {
      if (gen !== this.generation) return;
      if (video.videoWidth > 0) this.frameIn(video, video.videoWidth, video.videoHeight);
      this.fallbackHandle = video.requestVideoFrameCallback(loop);
    };
    this.fallbackHandle = video.requestVideoFrameCallback(loop);
  }

  private stopFrames(): void {
    const reader = this.reader;
    this.reader = null;
    if (reader) reader.cancel().catch(() => undefined);
    if (this.fallbackVideo && this.fallbackHandle) {
      this.fallbackVideo.cancelVideoFrameCallback(this.fallbackHandle);
    }
    this.fallbackHandle = 0;
    this.fallbackVideo = null;
  }

  /** A frame arrived: when recording, stamp it on the block clock, scale it and hand it to the encoder. */
  private frameIn(source: CanvasImageSource, srcW: number, srcH: number): void {
    const s = this.session;
    const encoder = this.encoder;
    const g = this.g;
    const canvas = this.canvas;
    const info = this._info;
    if (!s || !s.encoding || !encoder || !g || !canvas || !info) return;
    if (encoder.state !== 'configured') return;
    const now = performance.now();
    const sinceTick = Math.min(s.blockMs, Math.max(0, now - s.tickAt));
    const ms = s.seen * s.blockMs + sinceTick - CAMERA_LAG_MS;
    if (ms < 0) return; // before the microphone's first block
    let us = Math.round(ms * 1000);
    // at most CAPTURE_FPS a second, and never two frames on the same instant
    if (s.lastUs >= 0 && us - s.lastUs < (US / CAPTURE_FPS) * 0.85) return;
    if (us <= s.lastUs) us = s.lastUs + 1;
    // the encoder has fallen behind (a slow machine): dropping a frame is better than a growing queue
    if (encoder.encodeQueueSize > 2) return;
    // scale and crop to the stored size, keeping the picture centred
    const scale = Math.max(info.width / srcW, info.height / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    g.drawImage(source, (info.width - dw) / 2, (info.height - dh) / 2, dw, dh);
    const key = s.count === 0 || us - s.lastKeyUs >= KEY_EVERY_US;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(canvas, { timestamp: us, duration: Math.round(US / CAPTURE_FPS) });
    } catch (error) {
      console.warn('camera frame could not be made', error);
      return;
    }
    try {
      encoder.encode(frame, { keyFrame: key });
      s.lastUs = us;
      if (key) s.lastKeyUs = us;
      s.count++;
    } catch (error) {
      console.warn('camera frame could not be encoded', error);
    } finally {
      frame.close();
    }
  }

  /* ---------------------------------------------------------------- the encoder */

  private configureEncoder(): void {
    const info = this._info;
    const codec = CODECS.find((c) => c.codec === this.codec);
    if (!info || !codec) return;
    const session = this.session;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        // a chunk from a session that has since ended is of no use
        if (this.session !== session || !session) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        session.frames.push({
          key: chunk.type === 'key',
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? Math.round(US / CAPTURE_FPS),
          data,
        });
      },
      error: (error) => {
        console.warn('camera encoder failed; the rest of this recording has no picture', error);
        if (this.session === session && session) session.encoding = false;
      },
    });
    try {
      encoder.configure({
        codec: codec.codec,
        width: info.width,
        height: info.height,
        bitrate: CAPTURE_KBPS * 1000,
        framerate: CAPTURE_FPS,
        latencyMode: 'realtime',
        ...(codec.avc ? { avc: codec.avc } : {}),
      });
    } catch (error) {
      console.warn('camera encoder could not be configured', error);
      return;
    }
    this.encoder = encoder;
  }

  /** Lets go of every frame before the key frame at or before `keepFromUs`, in runs. */
  private prune(keepFromUs: number): void {
    const s = this.session;
    if (!s || s.frames.length < PRUNE_BATCH) return;
    let last = -1;
    for (let k = 0; k < s.frames.length; k++) {
      const f = s.frames[k];
      if (!f || f.timestamp > keepFromUs) break;
      if (f.key) last = k;
    }
    if (last >= PRUNE_BATCH) s.frames.splice(0, last);
  }

  private makeCanvas(width: number, height: number): void {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const g = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (g) {
        this.canvas = canvas;
        this.g = g;
        return;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
  }

  private setState(state: CameraState, error?: string): void {
    this._state = state;
    this.callbacks.onState(state, error);
  }
}

async function pickCodec(width: number, height: number): Promise<(typeof CODECS)[number] | null> {
  for (const c of CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        bitrate: CAPTURE_KBPS * 1000,
        framerate: CAPTURE_FPS,
        latencyMode: 'realtime',
        ...(c.avc ? { avc: c.avc } : {}),
      });
      if (supported) return c;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** What went wrong opening the camera, in words. */
function describeError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'The browser was not allowed to use the camera. Allow it in the address bar and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Plug one in or pick another one.';
    case 'NotReadableError':
      return 'The camera is in use by another app.';
    default:
      return (error as Error).message || 'The camera could not be opened.';
  }
}
