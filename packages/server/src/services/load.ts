/**
 * How busy the machine is right now: whole-machine CPU use, memory, this server process, and any
 * process by pid (ffmpeg while it runs). The browser polls this during an export so the user can see
 * what the export costs. Every probe is cheap and best effort: a figure that cannot be read is null.
 */
import os from 'node:os';

import { type ProcessLoad, type SystemLoad } from '@one-take/shared';

import { defaultExec, detectMemory, type Exec } from './system.js';

/** CPU time summed over every core, in the units `os.cpus()` uses. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Whole-machine CPU use between two readings, 0..100; null when no time has passed. */
export function cpuPercentBetween(earlier: CpuTimes, later: CpuTimes): number | null {
  const total = later.total - earlier.total;
  const idle = later.idle - earlier.idle;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

/** `ps -o %cpu=,rss= -p <pid>` prints `  97.3 123456` (rss in kB). */
export function parsePs(output: string): { cpuPercent: number; rssBytes: number } | null {
  const line = output.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const [cpu, rss] = line.trim().split(/\s+/);
  const cpuPercent = Number(cpu);
  const rssKb = Number(rss);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssKb)) return null;
  return { cpuPercent, rssBytes: rssKb * 1024 };
}

export interface LoadMonitorOptions {
  platform?: NodeJS.Platform;
  exec?: Exec;
  timeoutMs?: number;
  /** Readings closer together than this reuse the previous CPU figure (it needs time to mean anything). */
  minIntervalMs?: number;
}

export class LoadMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly exec: Exec;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private lastCpu: CpuTimes | null = null;
  private lastCpuAt = 0;
  private lastCpuPercent: number | null = null;
  private lastProcess: { usage: NodeJS.CpuUsage; at: number } | null = null;

  constructor(options: LoadMonitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.exec = options.exec ?? defaultExec;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  /** The machine right now. CPU use is averaged since the previous call (null on the first). */
  async sample(): Promise<SystemLoad> {
    const now = Date.now();
    const cpus = os.cpus();
    const times = cpuTimes(cpus);
    if (this.lastCpu === null) {
      this.lastCpu = times;
      this.lastCpuAt = now;
    } else if (now - this.lastCpuAt >= this.minIntervalMs) {
      this.lastCpuPercent = cpuPercentBetween(this.lastCpu, times);
      this.lastCpu = times;
      this.lastCpuAt = now;
    }
    const memory = await detectMemory(this.platform, this.exec, this.timeoutMs);
    return {
      at: new Date(now).toISOString(),
      cpu: { percent: this.lastCpuPercent, cores: cpus.length || os.availableParallelism() },
      memory: { totalBytes: memory.totalBytes, availableBytes: memory.availableBytes },
      server: this.self(now),
    };
  }

  /** This server process: CPU as a percentage of one core since the previous call, and resident memory. */
  private self(now: number): ProcessLoad {
    const usage = process.cpuUsage();
    let cpuPercent: number | null = null;
    if (this.lastProcess && now > this.lastProcess.at) {
      const busyUs =
        usage.user + usage.system - (this.lastProcess.usage.user + this.lastProcess.usage.system);
      cpuPercent = Math.max(0, (busyUs / 1000 / (now - this.lastProcess.at)) * 100);
    }
    this.lastProcess = { usage, at: now };
    return { pid: process.pid, cpuPercent, rssBytes: process.memoryUsage().rss };
  }

  /**
   * Another process by pid, through `ps` on macOS and Linux. On macOS `%cpu` is a recent average;
   * on Linux it is the average over the process's life, which for ffmpeg is the export so far.
   * Null where `ps` is missing (Windows) or the process is gone.
   */
  async process(pid: number): Promise<ProcessLoad | null> {
    if (this.platform === 'win32') return null;
    const out = await this.exec('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], this.timeoutMs);
    const parsed = out ? parsePs(out) : null;
    return parsed ? { pid, ...parsed } : null;
  }
}
