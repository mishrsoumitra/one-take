import { describe, expect, it } from 'vitest';

import { Semaphore } from '../src/util/semaphore.js';

describe('Semaphore', () => {
  it('hands out slots in order and passes a released slot straight on', async () => {
    const s = new Semaphore(1);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    const order: string[] = [];
    const a = s.acquire().then(() => order.push('a'));
    const b = s.acquire().then(() => order.push('b'));
    await Promise.resolve();
    expect(order).toEqual([]);
    s.release();
    await a;
    expect(order).toEqual(['a']);
    expect(s.available).toBe(0);
    s.release();
    await b;
    expect(order).toEqual(['a', 'b']);
    s.release();
    expect(s.available).toBe(1);
  });

  it('lets a waiter give up when its signal aborts', async () => {
    const s = new Semaphore(1);
    s.tryAcquire();
    const controller = new AbortController();
    const waiting = s.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    s.release();
    expect(s.available).toBe(1);
    await expect(s.acquire(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects silly sizes', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});
