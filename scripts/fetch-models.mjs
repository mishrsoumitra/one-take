#!/usr/bin/env node
/**
 * Fetches the model files for the voice check, the lip check and the camera cleanup into
 * packages/client/public/models, checking each against its SHA-256. Files already there and intact
 * are left alone. The server serves them from that folder directly (no rebuild needed), and a model
 * that is not there when the app first asks is fetched by the server itself into ~/.one-take/models;
 * this script is for doing it ahead of time, in one go, while the machine is online.
 *
 *   npm run models
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { MODELS } from '@one-take/shared';

const dir = path.resolve(import.meta.dirname, '../packages/client/public/models');
fs.mkdirSync(dir, { recursive: true });

/** @param {string} file */
function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** @param {number} bytes */
function mb(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

let failed = false;
for (const model of Object.values(MODELS)) {
  const target = path.join(dir, model.name);
  if (fs.existsSync(target) && sha256(target) === model.sha256) {
    console.log(`${model.name}: already here (${mb(model.bytes)})`);
    continue;
  }
  console.log(`${model.name}: fetching ${mb(model.bytes)} for ${model.what}…`);
  const partial = `${target}.part`;
  try {
    const response = await fetch(model.url);
    if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`);
    await pipeline(
      Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)),
      fs.createWriteStream(partial),
    );
    const got = sha256(partial);
    if (got !== model.sha256) throw new Error(`checksum mismatch: expected ${model.sha256}, got ${got}`);
    fs.renameSync(partial, target);
    console.log(`${model.name}: done`);
  } catch (error) {
    failed = true;
    fs.rmSync(partial, { force: true });
    console.error(`${model.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) {
  console.error(
    '\nSome models could not be fetched. Check the connection and run "npm run models" again; the server also fetches a missing model itself the first time the app asks for it.',
  );
  process.exit(1);
}
console.log(`\nModels are in ${dir}; the server serves them from there (no rebuild needed).`);
