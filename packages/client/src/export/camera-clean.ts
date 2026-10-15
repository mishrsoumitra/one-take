/**
 * The camera's picture cleaned up before it is drawn into the frame: the background blurred or
 * replaced behind the speaker (the segmenter's mask), and the exposure and colour evened out
 * (`core/exposure.ts`). One frame goes in, one comes out, at the picture's own size; the caller
 * (the overlay as the video is rendered) draws the result where the picture goes.
 *
 * The correction follows the frames slowly, so a speaker leaning into the light does not make the
 * picture pump; the mask is asked for every frame, and when the segmenter cannot run (no model,
 * no worker) the background is left as it is and the frame is only corrected.
 */
import { type Enhance } from '@one-take/shared';

import {
  applyLut,
  buildLut,
  followCorrection,
  isIdentity,
  measureTone,
  planCorrection,
  type Correction,
} from '../core/exposure.js';
import { type Segmenter } from '../vision/segmenter.js';

export type CameraCleanupSettings = Enhance['camera'];

/** The blur's radius as a share of the picture's width. */
const BLUR_SHARE = 0.03;
/** The mask's edge is softened over this many pixels of the picture's width, as a share. */
const EDGE_SHARE = 0.008;
/** Confidence under which a pixel is background for the replace mode. */
const PERSON_MIN = 0.5;

export class CameraCleaner {
  private readonly canvas: OffscreenCanvas;
  private readonly g: OffscreenCanvasRenderingContext2D;
  private readonly mask: OffscreenCanvas;
  private readonly maskG: OffscreenCanvasRenderingContext2D;
  private readonly person: OffscreenCanvas;
  private readonly personG: OffscreenCanvasRenderingContext2D;
  private correction: Correction | null = null;
  private maskImage: ImageData | null = null;
  /** The segmenter failed on a frame: the background is left alone from then on, and said once. */
  private segmentingFailed = false;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly settings: CameraCleanupSettings,
    private readonly segmenter: Segmenter | null,
  ) {
    const make = (): [OffscreenCanvas, OffscreenCanvasRenderingContext2D] => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('no 2d context for the camera cleanup');
      return [canvas, context];
    };
    [this.canvas, this.g] = make();
    [this.mask, this.maskG] = make();
    [this.person, this.personG] = make();
  }

  /** Whether the settings ask for anything at all. */
  static wanted(settings: CameraCleanupSettings): boolean {
    return settings.background !== 'keep' || settings.exposure;
  }

  /** The cleaned picture; valid until the next call. */
  async clean(frame: CanvasImageSource): Promise<OffscreenCanvas> {
    const { g, width, height } = this;
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
    g.drawImage(frame, 0, 0, width, height);
    if (this.settings.exposure) this.correct();
    if (this.settings.background !== 'keep' && this.segmenter && !this.segmentingFailed) {
      try {
        await this.separate();
      } catch (error) {
        this.segmentingFailed = true;
        console.warn('the background could not be told from the speaker; leaving it as it is', error);
      }
    }
    return this.canvas;
  }

  /** The exposure and colour, by a lookup table that follows the frames slowly. */
  private correct(): void {
    const image = this.g.getImageData(0, 0, this.width, this.height);
    const next = planCorrection(measureTone(image.data, 3));
    this.correction = followCorrection(this.correction, next);
    if (isIdentity(this.correction)) return;
    applyLut(image.data, buildLut(this.correction));
    this.g.putImageData(image, 0, 0);
  }

  /** The background blurred or painted over, the speaker drawn back on top through the mask. */
  private async separate(): Promise<void> {
    if (!this.segmenter) return;
    const { g, width, height } = this;
    const bitmap = await createImageBitmap(this.canvas);
    const result = await this.segmenter.segment(bitmap);
    // the mask as an image whose alpha is the person's confidence, at the picture's size
    const maskData =
      this.maskImage ?? (this.maskImage = this.maskG.createImageData(result.width, result.height));
    const px = maskData.data;
    for (let i = 0, k = 3; i < result.mask.length; i++, k += 4) {
      const c = result.mask[i] ?? 0;
      px[k] = Math.round(
        255 * (this.settings.background === 'replace' ? (c >= PERSON_MIN ? 1 : c / PERSON_MIN) : c),
      );
    }
    if (this.mask.width !== result.width || this.mask.height !== result.height) {
      this.mask.width = result.width;
      this.mask.height = result.height;
    }
    this.maskG.putImageData(maskData, 0, 0);
    // the speaker alone: the picture through the mask
    const pg = this.personG;
    pg.globalCompositeOperation = 'source-over';
    pg.filter = `blur(${Math.max(0.5, width * EDGE_SHARE).toFixed(2)}px)`;
    pg.clearRect(0, 0, width, height);
    pg.drawImage(this.mask, 0, 0, width, height);
    pg.filter = 'none';
    pg.globalCompositeOperation = 'source-in';
    pg.drawImage(this.canvas, 0, 0, width, height);
    // the background: the picture blurred, or a flat colour
    if (this.settings.background === 'blur') {
      const sharp = await createImageBitmap(this.canvas);
      g.filter = `blur(${Math.max(1, width * BLUR_SHARE).toFixed(1)}px)`;
      g.drawImage(sharp, 0, 0, width, height);
      sharp.close();
      g.filter = 'none';
    } else {
      g.fillStyle = this.settings.backdrop;
      g.fillRect(0, 0, width, height);
    }
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.person, 0, 0, width, height);
  }
}
