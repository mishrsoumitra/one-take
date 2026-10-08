export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit] ?? ''}`;
}

/** mm:ss, or h:mm:ss above an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Make a safe base file name: strips path separators and characters that are illegal on Windows or macOS,
 * trims dots and spaces, and falls back to `lecture`.
 */
export function sanitizeFileName(name: string, fallback = 'lecture'): string {
  // eslint-disable-next-line no-control-regex -- control characters are illegal in file names
  const illegal = /[\\/:*?"<>|\u0000-\u001f]+/g;
  const cleaned = name.replace(illegal, '-').replace(/\s+/g, ' ').trim();
  const trimmed = cleaned.replace(/^[. ]+|[. ]+$/g, '');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!trimmed || reserved.test(trimmed)) return fallback;
  return trimmed.slice(0, 120);
}

/** Strip a trailing extension such as `.pdf` from a file name. */
export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
