#!/usr/bin/env node
/**
 * `npm start`: everything the app needs, then the server, in one command.
 *
 *   1. the dependencies: `npm ci` when node_modules is missing or older than package-lock.json
 *      (`npm install` when there is no lockfile);
 *   2. the build: shared, server and client, when a source, a config or the dependencies changed
 *      since the last build (a stamp file in packages/client/dist remembers it);
 *   3. the models: the voice-check, lip-check and camera-cleanup files, through `npm run models`
 *      (already-fetched files are left alone; a download that fails, offline say, is only a note,
 *      the server fetches a missing model itself the first time the app asks);
 *   4. the server, with every argument after `npm start --` passed through.
 *
 *   npm start
 *   npm start -- --port 4317 --dir ~/Movies/One\ Take
 *
 * Each step says what it did. `node packages/server/dist/index.js` starts the server alone.
 * Only Node's own modules are used here, so the script runs before anything is installed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverArgs = process.argv.slice(2);

const LOCK = path.join(ROOT, 'package-lock.json');
const INSTALLED = path.join(ROOT, 'node_modules', '.package-lock.json');
const STAMP = path.join(ROOT, 'packages', 'client', 'dist', '.one-take-build');
const OUTPUTS = [
  'packages/shared/dist/index.js',
  'packages/server/dist/index.js',
  'packages/client/dist/index.html',
].map((p) => path.join(ROOT, p));
/** What the build reads: a change in any of these means a build. */
const SOURCES = [
  'packages/shared/src',
  'packages/server/src',
  'packages/client/src',
  'packages/client/index.html',
  'packages/client/public',
  'packages/client/vite.config.ts',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/client/package.json',
  'packages/shared/tsconfig.json',
  'packages/server/tsconfig.json',
  'packages/client/tsconfig.json',
  'tsconfig.base.json',
  'package.json',
].map((p) => path.join(ROOT, p));
/** Folders under the sources that are not sources: the models are served, not built. */
const NOT_SOURCES = new Set([path.join(ROOT, 'packages', 'client', 'public', 'models')]);

/** @param {string} text */
function say(text) {
  console.info(`One Take: ${text}`);
}

/** @param {string} file */
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The newest change among the files and folders given (folders recursively, `skip` left out), or
 * 0 when none of them exists.
 * @param {string[]} entries
 * @param {Set<string>} skip
 */
function newestMtime(entries, skip) {
  let newest = 0;
  /** @param {string} p */
  const visit = (p) => {
    if (skip.has(p)) return;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  for (const entry of entries) visit(entry);
  return newest;
}

/**
 * Runs a command to the end in the terminal; resolves with its exit code.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {Promise<number>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...options });
    child.on('error', (error) => {
      console.error(`${command}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Runs npm: the one running this script where it says which (npm_execpath), else the one on the PATH.
 * @param {string[]} args
 */
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /\.m?js$/.test(cli)) return run(process.execPath, [cli, ...args]);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: process.platform === 'win32' });
}

/** Why the dependencies need installing, or null when they are in place. */
function installReason() {
  const have = mtime(INSTALLED);
  if (have === null) return 'no node_modules yet';
  const want = mtime(LOCK);
  if (want !== null && want > have) return 'package-lock.json changed';
  return null;
}

/** Why the app needs building, or null when the build is up to date. */
function buildReason() {
  if (OUTPUTS.some((o) => mtime(o) === null)) return 'not built yet';
  const built = mtime(STAMP);
  if (built === null) return 'no record of the last build';
  if (newestMtime([...SOURCES, INSTALLED], NOT_SOURCES) > built) return 'a source or a dependency changed';
  return null;
}

async function main() {
  // 1. dependencies
  const install = installReason();
  if (install) {
    const useCi = mtime(LOCK) !== null;
    say(`installing the dependencies (${install})…`);
    const code = await npm([useCi ? 'ci' : 'install', '--no-audit', '--no-fund']);
    if (code !== 0) {
      say(`the dependencies could not be installed (npm exited with ${code}).`);
      process.exit(code);
    }
  } else {
    say('dependencies are in place.');
  }

  // 2. build
  const build = buildReason();
  if (build) {
    say(`building (${build})…`);
    const code = await npm(['run', 'build']);
    if (code !== 0) {
      say(`the build failed (exit code ${code}); the server was not started.`);
      process.exit(code);
    }
    fs.writeFileSync(STAMP, new Date().toISOString());
  } else {
    say('build is up to date.');
  }

  // 3. models
  say('models…');
  const models = await run(process.execPath, [path.join(ROOT, 'scripts', 'fetch-models.mjs')]);
  if (models !== 0) {
    say(
      'a model could not be fetched now; the server fetches a missing one itself when the app first asks for it.',
    );
  }

  // 4. the server
  say('starting the server…');
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'packages', 'server', 'dist', 'index.js'), ...serverArgs],
    {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  // Ctrl-C reaches the server too, and it shuts down on its own; this process waits for it so the
  // exit code is the server's. A signal sent to this process alone is passed on.
  process.on('SIGINT', () => undefined);
  process.on('SIGTERM', () => server.kill('SIGTERM'));
  server.on('error', (error) => {
    console.error(`the server could not start: ${error.message}`);
    process.exit(1);
  });
  server.on('close', (code) => process.exit(code ?? 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
