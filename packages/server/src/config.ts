import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface ServerConfig {
  host: string;
  port: number;
  /** Folder with the built client; null disables static serving (API only). */
  staticDir: string | null;
  /** Suggested output folder. */
  defaultDirectory: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Extra folders with fonts for drawing PowerPoint slides, searched before the system font folders. */
  fontDirectories: string[];
  logLevel: string;
  /** Accept requests whose Host header is not loopback (only for trusted networks). */
  allowRemote: boolean;
}

export const SERVER_VERSION = '1.0.0';

function builtClientDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../client/dist'), path.resolve(here, '../../../client/dist')];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
      static: { type: 'string' },
      dir: { type: 'string', short: 'd' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
      fonts: { type: 'string' },
      'log-level': { type: 'string' },
      'allow-remote': { type: 'boolean' },
      'no-static': { type: 'boolean' },
    },
    strict: true,
  });

  const port = Number(values.port ?? env.ONE_TAKE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${values.port ?? env.ONE_TAKE_PORT ?? ''}`);
  }
  const fontDirectories = (values.fonts ?? env.ONE_TAKE_FONTS ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map((dir) => path.resolve(dir));
  const defaultDirectory = path.resolve(
    values.dir ?? env.ONE_TAKE_DIR ?? path.join(os.homedir(), 'Movies', 'One Take'),
  );
  return {
    host: values.host ?? env.ONE_TAKE_HOST ?? '127.0.0.1',
    port,
    staticDir: values['no-static'] ? null : (values.static ?? env.ONE_TAKE_STATIC ?? builtClientDir()),
    defaultDirectory,
    ffmpegPath: values.ffmpeg ?? env.FFMPEG_PATH ?? null,
    ffprobePath: values.ffprobe ?? env.FFPROBE_PATH ?? null,
    fontDirectories,
    logLevel: values['log-level'] ?? env.ONE_TAKE_LOG_LEVEL ?? 'info',
    allowRemote: values['allow-remote'] ?? env.ONE_TAKE_ALLOW_REMOTE === '1',
  };
}
