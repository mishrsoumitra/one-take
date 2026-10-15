#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MODELS, type ServerCapabilities } from '@one-take/shared';

import { buildApp } from './app.js';
import { loadConfig, modelCacheDir, SERVER_VERSION } from './config.js';
import { PptxConverter, presentationSupport } from './services/convert.js';
import { detectFfmpeg, detectFfprobe } from './services/ffmpeg.js';
import { shortcutDirectories } from './services/filesystem.js';
import { JobManager } from './services/jobs.js';
import { ExportLibrary } from './services/library.js';
import { LoadMonitor } from './services/load.js';
import { ModelStore } from './services/models.js';
import { detectStudio, StudioManager } from './services/studio.js';
import {
  applyBenchmark,
  benchmarkDecoders,
  benchmarkEncoders,
  detectSystem,
  formatRaces,
  formatSystemReport,
  readRememberedBenchmark,
  rememberBenchmark,
  withoutBrokenEncoders,
} from './services/system.js';
import { detectTranscription, TranscriptionManager } from './services/transcribe.js';

const MIN_NODE_MAJOR = 22;

/** The system-check line for the client's model files: which are here, and what happens about the rest. */
async function describeModels(models: ModelStore): Promise<string> {
  const where = await models.locations();
  const here = where.filter((l) => l.path !== null);
  const missing = where.filter((l) => l.path === null);
  const folders = [...new Set(here.map((l) => path.dirname(l.path ?? '')))];
  const parts: string[] = [];
  if (here.length) {
    parts.push(
      `${here.length === where.length ? 'all' : here.map((l) => l.model.name).join(', ')} in ${folders.join(', ')}`,
    );
  }
  if (missing.length) {
    parts.push(
      `${missing.map((l) => l.model.name).join(', ')} not here: fetched into ${models.cacheDir} when the app first asks (or run "npm run models")`,
    );
  }
  return parts.join('; ');
}

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    throw new Error(`One Take needs Node ${MIN_NODE_MAJOR} or newer; this is ${process.version}.`);
  }
  const config = loadConfig();
  await fs.mkdir(config.defaultDirectory, { recursive: true }).catch(() => undefined);

  const [ffmpegFound, ffprobePath, shortcuts] = await Promise.all([
    detectFfmpeg(config.ffmpegPath),
    detectFfprobe(config.ffprobePath),
    shortcutDirectories(config.defaultDirectory),
  ]);

  // The pre-flight check: CPU, memory, GPU, disk, and which hardware encoders really work here.
  const system = await detectSystem({
    ffmpeg: ffmpegFound,
    outputDirectory: config.defaultDirectory,
    verify: config.selfTest,
  });
  const ffmpeg = ffmpegFound ? withoutBrokenEncoders(ffmpegFound, system) : null;
  // The races' figures from an earlier start on the same ffmpeg, so the start-up line and the export
  // dialog have them at once and the machine is not raced on every start.
  const benchmarkFile = path.join(config.dataDir, 'benchmark.json');
  const remembered = ffmpeg && config.benchmark ? await readRememberedBenchmark(benchmarkFile, ffmpeg) : null;
  if (remembered) applyBenchmark(system, remembered);
  const [transcriptionInfo, studioInfo] = await Promise.all([
    detectTranscription({
      whisperPath: config.whisperPath,
      whisperModel: config.whisperModel,
      dataDir: config.dataDir,
    }),
    config.studio
      ? detectStudio({
          dataDir: config.dataDir,
          pythonPath: config.studioPython,
          staticDir: config.staticDir,
        })
      : Promise.resolve(null),
  ]);

  const capabilities: ServerCapabilities = {
    name: 'one-take-server',
    version: SERVER_VERSION,
    platform: process.platform,
    homeDirectory: os.homedir(),
    defaultDirectory: config.defaultDirectory,
    ffmpeg,
    ffprobePath,
    shortcuts,
    presentations: presentationSupport,
    system,
    transcription: transcriptionInfo,
    studio: studioInfo,
  };

  const load = new LoadMonitor();
  const transcription = new TranscriptionManager({
    info: transcriptionInfo,
    dataDir: config.dataDir,
    log: (m) => app.log.info(m),
  });
  const studio = new StudioManager({
    info: studioInfo ?? {
      python: null,
      device: null,
      models: { denoise: false, separate: false, extract: false },
      speaker: false,
      denoise: false,
      voice: false,
      note: 'The studio is switched off (--no-studio).',
    },
    dataDir: config.dataDir,
    staticDir: config.staticDir,
    log: (m) => app.log.info(m),
  });
  const library = new ExportLibrary(path.join(config.dataDir, 'exports.json'), {
    log: (m) => app.log.info(m),
  });
  const jobs = new JobManager({
    ffmpeg,
    system,
    log: (m) => app.log.info(m),
    processLoad: (pid) => load.process(pid),
    library,
  });
  const converter = new PptxConverter({
    fontDirectories: config.fontDirectories,
    memoryLimitMb: config.rendererMemoryMb ?? undefined,
    log: (m) => app.log.info(m),
  });
  const models = new ModelStore({
    catalogue: MODELS,
    dirs: config.modelDirs,
    cacheDir: modelCacheDir(config.dataDir),
    log: (m) => app.log.info(m),
  });
  const app = buildApp({
    config,
    jobs,
    converter,
    capabilities: () => capabilities,
    load,
    library,
    transcription,
    studio,
    models,
  });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await Promise.all([jobs.dispose(), converter.dispose(), transcription.dispose(), studio.dispose()]);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const quiet = ['warn', 'error', 'fatal', 'silent'].includes(config.logLevel);
  if (!quiet) {
    console.info(`One Take ${SERVER_VERSION}: system check`);
    const report = formatSystemReport(system, ffmpeg, {
      races: config.benchmark ? 'pending' : 'off',
      rememberedAt: remembered?.at ?? null,
    });
    for (const line of report) console.info(`  ${line}`);
    console.info(`  Renderer ${(converter.memoryLimit / 1024).toFixed(1)} GB heap for PowerPoint conversion`);
    console.info(
      `  Speech   ${transcriptionInfo ? transcriptionInfo.note : 'no whisper found: transcripts and subtitles are off (brew install openai-whisper, or whisper-cpp)'}`,
    );
    console.info(`  Studio   ${studioInfo ? studioInfo.note : 'switched off (--no-studio)'}`);
    console.info(`  Models   ${await describeModels(models)}`);
    console.info('');
  }

  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  app.log.info(`One Take server ${SERVER_VERSION} at ${url}`);
  app.log.info(
    ffmpeg
      ? `ffmpeg ${ffmpeg.version} at ${ffmpeg.path}`
      : 'ffmpeg not found: HLS, DASH and compression are disabled',
  );
  app.log.info(
    `PowerPoint files (${presentationSupport.extensions.map((e) => `.${e}`).join(' ')}) are converted with ${presentationSupport.renderer}${config.fontDirectories.length ? `; extra fonts from ${config.fontDirectories.join(', ')}` : ''}`,
  );
  app.log.info(
    config.staticDir
      ? `serving app from ${config.staticDir}`
      : 'API only (no built client found; run "npm run build")',
  );
  app.log.info(`default output folder: ${config.defaultDirectory}`);
  app.log.info(`finished exports are listed in ${library.filePath}`);

  // The races (each encoder, then the CPU against each hardware decoder) run a few seconds after the
  // server answers, so start-up stays quick and they rarely overlap the browser's own encoder test on
  // first load; the profile is updated in place, the next /api/capabilities call sees the figures, and
  // they are kept in the data folder so the next start has them at once. They inform; the hardware
  // switch decides.
  if (ffmpeg && system.ffmpeg && config.benchmark && !remembered) {
    const race = async () => {
      const encoders = await benchmarkEncoders(ffmpeg, system, { log: (m) => app.log.info(m) });
      const decoders = await benchmarkDecoders(ffmpeg, system, { log: (m) => app.log.info(m) });
      if (!system.ffmpeg) return;
      const data = {
        ffmpeg: { path: ffmpeg.path, version: ffmpeg.version },
        at: new Date().toISOString(),
        encoders: encoders.results,
        fastestEncoder: encoders.fastestEncoder,
        decoders: decoders.results,
      };
      applyBenchmark(system, data);
      const line = formatRaces(system.ffmpeg) ?? 'races: nothing could be measured';
      app.log.info(line);
      if (!quiet) console.info(`  ${line}; kept in ${benchmarkFile}`);
      await rememberBenchmark(benchmarkFile, data).catch((error: unknown) =>
        app.log.warn(
          `the races' figures could not be kept: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    };
    setTimeout(() => void race().catch((error: unknown) => app.log.warn(String(error))), 3000).unref();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
