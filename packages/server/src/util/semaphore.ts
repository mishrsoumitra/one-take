/** A counting semaphore for things that must not all run at once (ffmpeg re-encodes share the cores). */
export class Semaphore {
  private readonly waiting: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal }[] =
    [];
  private used = 0;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error('Semaphore size must be a positive integer');
  }

  get available(): number {
    return this.size - this.used;
  }

  /** Takes a slot right away when one is free. */
  tryAcquire(): boolean {
    if (this.used >= this.size) return false;
    this.used++;
    return true;
  }

  /** Waits for a slot; rejects with an AbortError when the signal fires first or has fired already. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, signal };
      this.waiting.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true },
      );
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.resolve(); // the slot passes straight on
      return;
    }
    this.used = Math.max(0, this.used - 1);
  }
}
