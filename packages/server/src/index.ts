#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';

import { type ServerCapabilities } from '@one-take/shared';

import { buildApp } from './app.js';
import { loadConfig, SERVER_VERSION } from './config.js';
import { PptxConverter, presentationSupport } from './services/convert.js';
import { detectFfmpeg, detectFfprobe } from './services/ffmpeg.js';
import { shortcutDirectories } from './services/filesystem.js';
import { JobManager } from './services/jobs.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await fs.mkdir(config.defaultDirectory, { recursive: true }).catch(() => undefined);

  const [ffmpeg, ffprobePath, shortcuts] = await Promise.all([
    detectFfmpeg(config.ffmpegPath),
    detectFfprobe(config.ffprobePath),
    shortcutDirectories(config.defaultDirectory),
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
  };

  const jobs = new JobManager({ ffmpeg, log: (m) => app.log.info(m) });
  const converter = new PptxConverter({
    fontDirectories: config.fontDirectories,
    log: (m) => app.log.info(m),
  });
  const app = buildApp({ config, jobs, converter, capabilities: () => capabilities });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await Promise.all([jobs.dispose(), converter.dispose()]);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
