#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type ServerCapabilities } from '@one-take/shared';

import { buildApp } from './app.js';
import { loadConfig, SERVER_VERSION } from './config.js';
import { PptxConverter, presentationSupport } from './services/convert.js';
import { detectFfmpeg, detectFfprobe } from './services/ffmpeg.js';
import { shortcutDirectories } from './services/filesystem.js';
import { JobManager } from './services/jobs.js';
import { ExportLibrary } from './services/library.js';
import { LoadMonitor } from './services/load.js';
import {
  benchmarkEncoders,
  detectSystem,
  formatSystemReport,
  withoutBrokenEncoders,
} from './services/system.js';

const MIN_NODE_MAJOR = 22;

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
  };

  const load = new LoadMonitor();
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
  const app = buildApp({ config, jobs, converter, capabilities: () => capabilities, load, library });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await Promise.all([jobs.dispose(), converter.dispose()]);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const quiet = ['warn', 'error', 'fatal', 'silent'].includes(config.logLevel);
  if (!quiet) {
    console.info(`One Take ${SERVER_VERSION}: system check`);
    for (const line of formatSystemReport(system, ffmpeg)) console.info(`  ${line}`);
    console.info(`  Renderer ${(converter.memoryLimit / 1024).toFixed(1)} GB heap for PowerPoint conversion`);
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

  // The encoder race runs a few seconds after the server answers, so start-up stays quick and the race
  // rarely overlaps the browser's own encoder test on first load; the profile is updated in place and
  // the next /api/capabilities call sees the winner.
  if (ffmpeg && system.ffmpeg && config.benchmark) {
    const race = () =>
      void benchmarkEncoders(ffmpeg, system, { log: (m) => app.log.info(m) }).then((result) => {
        if (!system.ffmpeg) return;
        system.ffmpeg.benchmark = result.results;
        system.ffmpeg.fastestEncoder = result.fastestEncoder;
        app.log.info(
          result.fastestEncoder
            ? `fastest H.264 encoder for slides at 1080p: ${result.fastestEncoder} (${Object.entries(
                result.results,
              )
                .map(([e, fps]) => `${e} ${fps} fps`)
                .join(', ')})`
            : 'encoder benchmark could not run',
        );
      });
    setTimeout(race, 3000).unref();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
