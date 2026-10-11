import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { cpuPercentBetween, cpuTimes, LoadMonitor, parsePs } from '../src/services/load.js';

function cpu(times: Partial<os.CpuInfo['times']>): os.CpuInfo {
  return {
    model: 'test',
    speed: 1,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
  };
}

describe('cpu use', () => {
  it('is the busy share of the time that passed on every core', () => {
    const before = cpuTimes([cpu({ user: 100, idle: 900 }), cpu({ user: 0, idle: 1000 })]);
    const after = cpuTimes([cpu({ user: 600, idle: 900 }), cpu({ sys: 100, idle: 1400 })]);
    // 1000 units passed on the two cores together; 600 of them were busy
    expect(cpuPercentBetween(before, after)).toBeCloseTo(60, 5);
    expect(cpuPercentBetween(before, before)).toBeNull();
  });

  it('reads what ps prints', () => {
    expect(parsePs('  97.3 123456\n')).toEqual({ cpuPercent: 97.3, rssBytes: 123456 * 1024 });
    expect(parsePs('')).toBeNull();
    expect(parsePs('%CPU RSS\n')).toBeNull();
  });
});

describe('LoadMonitor', () => {
  it('reports the machine, this process, and cpu use from the second sample on', async () => {
    const monitor = new LoadMonitor({ minIntervalMs: 0 });
    const first = await monitor.sample();
    expect(first.cpu.cores).toBeGreaterThan(0);
    expect(first.memory.totalBytes).toBe(os.totalmem());
    expect(first.server.pid).toBe(process.pid);
    expect(first.server.rssBytes).toBeGreaterThan(0);
    // burn a little CPU so the delta is not empty
    const until = Date.now() + 30;
    while (Date.now() < until) Math.sqrt(Math.random());
    const second = await monitor.sample();
    expect(second.cpu.percent).not.toBeNull();
    expect(second.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(second.cpu.percent).toBeLessThanOrEqual(100);
    expect(second.server.cpuPercent).not.toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reads another process through ps', async () => {
    const monitor = new LoadMonitor();
    const me = await monitor.process(process.pid);
    expect(me).not.toBeNull();
    expect(me?.rssBytes).toBeGreaterThan(0);
    expect(me?.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(await monitor.process(2 ** 22 - 1)).toBeNull();
  });

  it('answers null for a process on Windows, where ps is missing', async () => {
    const monitor = new LoadMonitor({ platform: 'win32', exec: () => Promise.resolve(null) });
    expect(await monitor.process(1)).toBeNull();
  });
});
