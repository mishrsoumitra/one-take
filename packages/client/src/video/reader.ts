/**
 * Plays a clip's video back, frame by frame, in order: the export asks for the frame at each moment
 * of a phrase, the preview asks for the frame at the moment being played. Time only ever moves
 * forward within a reader; a seek backwards is a new reader.
 *
 * Each piece of the clip is decoded by its own `VideoDecoder`, fed a few chunks ahead of what has
 * come out, so a long phrase never has more than a handful of decoded frames in memory. The frames
 * before the piece's start are decoded and dropped; a decoder that fails leaves the rest of its piece
 * without a picture rather than stopping the export.
 */
import { frameTimeAt, type ClipVideo, type VideoPiece } from '../core/clip-video.js';

/** Chunks fed to a decoder beyond what it has given back. */
const AHEAD = 6;
/** A decoder that has given nothing back for this long is given up on. */
const STALL_MS = 4000;

class PieceDecoder {
  private readonly decoder: VideoDecoder;
  private readonly queue: VideoFrame[] = [];
  private fed = 0;
  private out = 0;
  private flushed = false;
  private failed = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly piece: VideoPiece,
    video: ClipVideo,
  ) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.out++;
        this.queue.push(frame);
        this.wakeUp();
      },
      error: (error) => {
        console.warn('camera video could not be decoded; the rest of this piece has no picture', error);
        this.failed = true;
        this.wakeUp();
      },
    });
    try {
      this.decoder.configure({
        codec: video.codec,
        codedWidth: video.width,
        codedHeight: video.height,
        optimizeForLatency: true,
      });
    } catch (error) {
      console.warn('camera video decoder could not be configured', error);
      this.failed = true;
    }
  }

  /** The next frame in order, or null once the piece is over (or the decoder gave up). */
  async next(): Promise<VideoFrame | null> {
    for (;;) {
      const frame = this.queue.shift();
      if (frame) return frame;
      if (this.failed || this.decoder.state === 'closed') return null;
      if (this.fed < this.piece.frames.length) {
        this.feed();
        if (this.queue.length > 0) continue;
        await this.waitForOutput();
        continue;
      }
      if (!this.flushed) {
        this.flushed = true;
        try {
          await this.decoder.flush();
        } catch {
          this.failed = true;
        }
        continue;
      }
      return null;
    }
  }

  close(): void {
    for (const f of this.queue) f.close();
    this.queue.length = 0;
    if (this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* already closed */
      }
    }
    this.failed = true;
    this.wakeUp();
  }

  private feed(): void {
    const frames = this.piece.frames;
    while (this.fed < frames.length && this.fed - this.out < AHEAD && !this.failed) {
      const f = frames[this.fed++];
      if (!f) break;
      try {
        this.decoder.decode(
          new EncodedVideoChunk({
            type: f.key ? 'key' : 'delta',
            timestamp: f.timestamp,
            duration: f.duration,
            data: f.data,
          }),
        );
      } catch (error) {
        console.warn('camera video chunk rejected', error);
        this.failed = true;
      }
    }
  }

  private waitForOutput(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        this.failed = true;
        resolve();
      }, STALL_MS);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private wakeUp(): void {
    this.wake?.();
  }
}

export class ClipReader {
  private pieceIndex = -1;
  /** Where the current piece starts, in µs of clip time. */
  private pieceStartUs = 0;
  private decoder: PieceDecoder | null = null;
  /** The frame on screen; owned by the reader. */
  private current: VideoFrame | null = null;
  /** The frame after it, decoded ahead but not yet due. */
  private upcoming: VideoFrame | null = null;
  private closed = false;

  constructor(private readonly video: ClipVideo) {}

  /** The frame to show `sec` into the clip. Calls must not go back in time. Null while there is no picture yet. */
  async frameAt(sec: number): Promise<VideoFrame | null> {
    if (this.closed) return null;
    const us = Math.max(0, sec * 1_000_000);
    const pieces = this.video.pieces;
    // move on to the piece this moment falls in (the last piece holds to the end)
    while (
      this.pieceIndex < pieces.length - 1 &&
      (this.pieceIndex < 0 || us >= this.pieceStartUs + (pieces[this.pieceIndex]?.durationUs ?? 0))
    ) {
      if (this.pieceIndex >= 0) this.pieceStartUs += pieces[this.pieceIndex]?.durationUs ?? 0;
      this.pieceIndex++;
      this.openPiece();
    }
    const piece = pieces[this.pieceIndex];
    const decoder = this.decoder;
    if (!piece || !decoder) return this.current;
    const target = frameTimeAt(piece, us - this.pieceStartUs);
    for (;;) {
      if (!this.upcoming) {
        this.upcoming = await decoder.next();
        // closed (current is null then), or moved on to another piece, while the frame was decoding
        if (this.decoder !== decoder) {
          this.upcoming?.close();
          this.upcoming = null;
          return this.current;
        }
        if (!this.upcoming) break; // the piece is over: hold the last frame
      }
      // the first frame stands in until it is due; after that a frame is shown once it is due
      if (this.upcoming.timestamp <= target || this.current === null) {
        this.current?.close();
        this.current = this.upcoming;
        this.upcoming = null;
        if (this.current.timestamp > target) break;
        continue;
      }
      break;
    }
    return this.current;
  }

  private openPiece(): void {
    this.decoder?.close();
    this.upcoming?.close();
    this.upcoming = null;
    const piece = this.video.pieces[this.pieceIndex];
    this.decoder = piece ? new PieceDecoder(piece, this.video) : null;
  }

  close(): void {
    this.closed = true;
    this.decoder?.close();
    this.decoder = null;
    this.current?.close();
    this.current = null;
    this.upcoming?.close();
    this.upcoming = null;
  }
}
