import { formatDuration } from '@one-take/shared';

/** `3.4s` under ten seconds, otherwise `m:ss`. */
export function fmtSec(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(1)}s` : formatDuration(seconds);
}

export { formatDuration as fmtTime };
