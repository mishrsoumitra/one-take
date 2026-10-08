import { type ExportPlan } from './plan.js';
import { CRF_RANGES } from './presets.js';

export interface ExportEstimate {
  /** Bytes the browser will write (upper bound). */
  uploadBytes: number;
  /** Bytes of the final output (upper bound, rough when the server re-encodes). */
  finalBytes: number;
  /** Extra bytes needed temporarily on the destination disk. */
  tempBytes: number;
  frames: number;
}

/** Rough bitrate (kbit/s at 1080p) a CRF value yields on slide content; scaled by pixel count. */
function crfKbps(codec: 'h264' | 'h265' | 'vp9' | 'av1', crf: number, width: number, height: number): number {
  const range = CRF_RANGES[codec];
  const span = range.max - range.min;
  const t = (crf - range.min) / span; // 0 = best quality
  const base = codec === 'h264' ? 8000 : 5000;
  const kbps = base * Math.pow(0.03, t);
  return Math.max(100, kbps * ((width * height) / (1920 * 1080)));
}

export function estimateExport(plan: ExportPlan, durationSec: number): ExportEstimate {
  const { browser, processing } = plan;
  const frames = Math.ceil(durationSec * browser.fps) + Math.ceil(0.25 * browser.fps);
  const uploadBytes = Math.round(
    (((browser.videoBitrateKbps + browser.audioBitrateKbps) * 1000 * durationSec) / 8) * 1.03,
  );
  let finalBytes = uploadBytes;
  let tempBytes = 0;
  if (processing) {
    tempBytes = uploadBytes;
    if (processing.video.mode === 'encode') {
      const v = processing.video;
      const h = v.height ?? browser.height;
      const w = Math.round((browser.width * h) / browser.height);
      const videoKbps = v.maxBitrateKbps ?? crfKbps(v.codec, v.crf, w, h);
      const audioKbps =
        processing.audio.mode === 'encode' ? processing.audio.bitrateKbps : browser.audioBitrateKbps;
      finalBytes = Math.round((((videoKbps + audioKbps) * 1000 * durationSec) / 8) * 1.03);
      if (processing.ladder) {
        finalBytes = processing.ladder.reduce(
          (sum, rung) =>
            sum +
            Math.round((((rung.videoBitrateKbps + rung.audioBitrateKbps) * 1000 * durationSec) / 8) * 1.03),
          0,
        );
      }
    }
  }
  return { uploadBytes, finalBytes, tempBytes, frames };
}
