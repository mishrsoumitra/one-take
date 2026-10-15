#!/usr/bin/env node
/**
 * Sets the studio up: a Python environment of its own under the server's data folder with
 * ClearerVoice-Studio in it, the three model checkpoints from Hugging Face, and the speaker model.
 * Run it once, then restart the server; it says what it found and what it fetched, and running it
 * again only fills in what is missing.
 *
 *   npm run studio
 *   npm run studio -- --python /usr/local/bin/python3.12    (a particular Python 3.10 to 3.13)
 *   npm run studio -- --models-only                         (the environment is already there)
 *
 * The environment goes under ONE_TAKE_DATA_DIR (default ~/.one-take) as studio/venv, the models as
 * studio/models/<name>. About 1.7 GB of checkpoints and some 300 MB of Python packages.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { MODELS, STUDIO_MODELS, STUDIO_PACKAGES } from '@one-take/shared';

const { values } = parseArgs({
  options: { python: { type: 'string' }, 'models-only': { type: 'boolean' }, 'data-dir': { type: 'string' } },
});
const dataDir = path.resolve(
  values['data-dir'] ?? process.env.ONE_TAKE_DATA_DIR ?? path.join(os.homedir(), '.one-take'),
);
const studio = path.join(dataDir, 'studio');
const venv = path.join(studio, 'venv');
const modelsDir = path.join(studio, 'models');
const venvPython =
  process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
fs.mkdirSync(modelsDir, { recursive: true });

/** @param {string} file */
function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** @param {number} bytes */
const mb = (bytes) => `${(bytes / 1_048_576).toFixed(0)} MB`;

/** @param {string} program @param {string[]} args */
function run(program, args, quiet = false) {
  const result = spawnSync(program, args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} exited with ${result.status}`);
  return result.stdout ?? '';
}

/** @param {string} program */
function versionOf(program) {
  try {
    const out = execFileSync(program, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8',
    }).trim();
    const [major, minor] = out.split('.').map(Number);
    return { major, minor };
  } catch {
    return null;
  }
}

/** A Python the model packages have wheels for. */
function usablePython() {
  if (values.python) return values.python;
  for (const candidate of ['python3.12', 'python3.11', 'python3.13', 'python3.10', 'python3', 'python']) {
    const v = versionOf(candidate);
    if (v && v.major === 3 && v.minor >= 10 && v.minor <= 13) return candidate;
  }
  return null;
}

function hasUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the environment */

if (!values['models-only']) {
  const uv = hasUv();
  if (!fs.existsSync(venvPython)) {
    console.log(`Making the studio's Python environment in ${venv}…`);
    if (uv) {
      run('uv', ['venv', '--python', values.python ?? '3.12', venv]);
    } else {
      const python = usablePython();
      if (!python) {
        console.error(
          'No Python 3.10 to 3.13 was found. Install one (brew install python@3.12, or uv) and run this again.',
        );
        process.exit(1);
      }
      run(python, ['-m', 'venv', venv]);
    }
  } else {
    console.log(`The studio's Python environment is at ${venv}`);
  }
  console.log(
    `Installing ${STUDIO_PACKAGES.join(', ')} (ClearerVoice-Studio and what it needs: torch and friends)…`,
  );
  if (uv) run('uv', ['pip', 'install', '--python', venvPython, ...STUDIO_PACKAGES]);
  else run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', ...STUDIO_PACKAGES]);
}

if (!fs.existsSync(venvPython)) {
  console.error(`No studio environment at ${venvPython}; run without --models-only first.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ the checkpoints */

const fetchScript = `
import os, sys
from huggingface_hub import snapshot_download
repo, target = sys.argv[1], sys.argv[2]
snapshot_download(repo_id=repo, local_dir=target, allow_patterns=['last_best_checkpoint', 'last_best_checkpoint.pt', 'README.md'])
`;
let failed = false;
for (const model of Object.values(STUDIO_MODELS)) {
  const target = path.join(modelsDir, model.name);
  const checkpoint = path.join(target, 'last_best_checkpoint.pt');
  if (fs.existsSync(checkpoint) && fs.existsSync(path.join(target, 'last_best_checkpoint'))) {
    console.log(`${model.name}: already here (${mb(fs.statSync(checkpoint).size)})`);
    continue;
  }
  console.log(
    `${model.name}: fetching about ${mb(model.bytes)} from Hugging Face (${model.repo}) for ${model.what}…`,
  );
  try {
    run(venvPython, ['-I', '-c', fetchScript, model.repo, target]);
    console.log(`${model.name}: done`);
  } catch (error) {
    failed = true;
    console.error(`${model.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------------------ the speaker model */

const speaker = MODELS.speaker;
const speakerTarget = path.join(modelsDir, speaker.name);
if (fs.existsSync(speakerTarget) && sha256(speakerTarget) === speaker.sha256) {
  console.log(`${speaker.name}: already here`);
} else {
  console.log(`${speaker.name}: fetching ${mb(speaker.bytes)} for picking a voice by its profile…`);
  const partial = `${speakerTarget}.part`;
  try {
    const response = await fetch(speaker.url);
    if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`);
    await pipeline(
      Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)),
      fs.createWriteStream(partial),
    );
    const got = sha256(partial);
    if (got !== speaker.sha256) throw new Error(`checksum mismatch: expected ${speaker.sha256}, got ${got}`);
    fs.renameSync(partial, speakerTarget);
    console.log(`${speaker.name}: done`);
  } catch (error) {
    failed = true;
    fs.rmSync(partial, { force: true });
    console.error(
      `${speaker.name}: ${error instanceof Error ? error.message : String(error)} (without it a voice is picked by its level)`,
    );
  }
}

/* ------------------------------------------------------------------ the check */

console.log('\nChecking the environment…');
const worker = path.resolve(import.meta.dirname, '../packages/server/py/studio.py');
try {
  const out = run(
    venvPython,
    ['-I', worker, '--models', modelsDir, '--speaker', speakerTarget, '--check'],
    true,
  );
  const line = out.trim().split('\n').pop() ?? '{}';
  const info = JSON.parse(line);
  if (info.error) {
    console.error(`The environment does not import: ${info.error}`);
    failed = true;
  } else {
    console.log(
      `torch ${info.torch} on the ${info.device}; models: ${Object.entries(info.models)
        .map(([k, v]) => `${k} ${v ? 'ok' : 'missing'}`)
        .join(', ')}; speaker ${info.speaker ? 'ok' : 'missing'}`,
    );
  }
} catch (error) {
  console.error(`The check failed: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
}

if (failed) {
  console.error(
    '\nSomething is missing; run this again when the network is back. The server greys out what it cannot run.',
  );
  process.exit(1);
}
console.log(
  `\nThe studio is ready in ${studio}. Restart the server (npm start) and the export dialog shows the deep clean and "keep only my voice".`,
);
