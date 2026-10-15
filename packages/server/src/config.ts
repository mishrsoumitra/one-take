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
  /** Where the server keeps its own small files: the list of finished exports. */
  dataDir: string;
  /**
   * Folders a client model file (the voice check, the lip check) may be in, searched in order: the built
   * client, `packages/client/public/models` (where `npm run models` puts them), the data folder's
   * `models`, the studio's `models`. A model in none of them is fetched into the data folder.
   */
  modelDirs: string[];
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Extra folders with fonts for drawing PowerPoint slides, searched before the system font folders. */
  fontDirectories: string[];
  logLevel: string;
  /** Accept requests whose Host header is not loopback (only for trusted networks). */
  allowRemote: boolean;
  /** Run a short test encode with each hardware encoder at start-up (about 0.2 s each). */
  selfTest: boolean;
  /** Race the H.264 encoders in the background after start-up (about a second each). */
  benchmark: boolean;
  /** Heap for the PowerPoint renderer in MB; null picks half the machine's memory. */
  rendererMemoryMb: number | null;
  /** A whisper program for transcripts (`whisper-cli` or `whisper`); null searches the PATH. */
  whisperPath: string | null;
  /** The model: a name for openai-whisper (`base.en`), a ggml file for whisper.cpp. */
  whisperModel: string | null;
  /** A Python with the studio's packages, instead of the environment `npm run studio` makes under the data folder. */
  studioPython: string | null;
  /** Skip the studio check at start-up (its switches stay greyed out). */
  studio: boolean;
}

export const SERVER_VERSION = '1.0.0';

function builtClientDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../client/dist'), path.resolve(here, '../../../client/dist')];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

/** `packages/client/public/models` next to this server, whether or not it exists yet. */
function clientModelsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../client/public/models');
}

/** Where the server's own fetched models go. */
export function modelCacheDir(dataDir: string): string {
  return path.join(dataDir, 'models');
}

/** The folders a client model file is looked for in, in order (see `ServerConfig.modelDirs`). */
export function modelSearchDirs(dataDir: string, staticDir: string | null): string[] {
  const dirs = staticDir ? [path.join(path.resolve(staticDir), 'models')] : [];
  dirs.push(clientModelsDir(), modelCacheDir(dataDir), path.join(dataDir, 'studio', 'models'));
  return [...new Set(dirs)];
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
      'data-dir': { type: 'string' },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
      fonts: { type: 'string' },
      'log-level': { type: 'string' },
      'allow-remote': { type: 'boolean' },
      'no-static': { type: 'boolean' },
      'no-self-test': { type: 'boolean' },
      'no-benchmark': { type: 'boolean' },
      'renderer-memory': { type: 'string' },
      whisper: { type: 'string' },
      'whisper-model': { type: 'string' },
      'studio-python': { type: 'string' },
      'no-studio': { type: 'boolean' },
    },
    strict: true,
  });
  const rendererMemory = values['renderer-memory'] ?? env.ONE_TAKE_RENDERER_MEMORY_MB;
  const rendererMemoryMb = rendererMemory === undefined ? null : Number(rendererMemory);
  if (rendererMemoryMb !== null && (!Number.isInteger(rendererMemoryMb) || rendererMemoryMb < 256)) {
    throw new Error(`Invalid renderer memory (MB, at least 256): ${rendererMemory ?? ''}`);
  }

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
  const dataDir = path.resolve(
    values['data-dir'] ?? env.ONE_TAKE_DATA_DIR ?? path.join(os.homedir(), '.one-take'),
  );
  const staticDir = values['no-static'] ? null : (values.static ?? env.ONE_TAKE_STATIC ?? builtClientDir());
  return {
    host: values.host ?? env.ONE_TAKE_HOST ?? '127.0.0.1',
    port,
    staticDir,
    defaultDirectory,
    dataDir,
    modelDirs: modelSearchDirs(dataDir, staticDir),
    ffmpegPath: values.ffmpeg ?? env.FFMPEG_PATH ?? null,
    ffprobePath: values.ffprobe ?? env.FFPROBE_PATH ?? null,
    fontDirectories,
    logLevel: values['log-level'] ?? env.ONE_TAKE_LOG_LEVEL ?? 'info',
    allowRemote: values['allow-remote'] ?? env.ONE_TAKE_ALLOW_REMOTE === '1',
    selfTest: !(values['no-self-test'] ?? env.ONE_TAKE_SELF_TEST === '0'),
    benchmark: !(values['no-benchmark'] ?? env.ONE_TAKE_BENCHMARK === '0'),
    rendererMemoryMb,
    whisperPath: values.whisper ?? env.ONE_TAKE_WHISPER ?? null,
    whisperModel: values['whisper-model'] ?? env.ONE_TAKE_WHISPER_MODEL ?? null,
    studioPython: values['studio-python'] ?? env.ONE_TAKE_STUDIO_PYTHON ?? null,
    studio: !(values['no-studio'] ?? env.ONE_TAKE_STUDIO === '0'),
  };
}
