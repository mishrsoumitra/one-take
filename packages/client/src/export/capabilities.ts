import { type BrowserCapabilities } from '@one-take/shared';
import { getEncodableAudioCodecs, getEncodableVideoCodecs } from 'mediabunny';

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

export function hasFileSystemAccess(): boolean {
  return typeof window.showSaveFilePicker === 'function';
}

/** Which codecs this browser can encode at 1080p; checked once and cached by the caller. */
export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  if (!hasWebCodecs()) return { videoCodecs: [], audioCodecs: [], fileSystemAccess: hasFileSystemAccess() };
  const [video, audio] = await Promise.all([
    getEncodableVideoCodecs(['avc', 'hevc', 'vp9', 'av1'], { width: 1920, height: 1080, bitrate: 4_000_000 }),
    getEncodableAudioCodecs(['aac', 'opus'], { numberOfChannels: 1, sampleRate: 48000, bitrate: 96_000 }),
  ]);
  return {
    videoCodecs: video.filter(
      (c): c is 'avc' | 'hevc' | 'vp9' | 'av1' => c === 'avc' || c === 'hevc' || c === 'vp9' || c === 'av1',
    ),
    audioCodecs: audio.filter((c): c is 'aac' | 'opus' => c === 'aac' || c === 'opus'),
    fileSystemAccess: hasFileSystemAccess(),
  };
}
