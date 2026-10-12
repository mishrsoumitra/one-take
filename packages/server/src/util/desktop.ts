/** Hands a path to the desktop: the file manager with the item selected, or the default application. */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { ApiError } from './errors.js';

function launch(cmd: string, args: string[], what: string): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch (error) {
    throw new ApiError(500, 'reveal_failed', `Could not open ${what}: ${(error as Error).message}`);
  }
}

/** Opens Finder, Explorer or the file manager at `target`, with it selected where the platform allows. */
export function revealInFileManager(target: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') launch('open', ['-R', target], 'the file manager');
  else if (platform === 'win32') launch('explorer.exe', [`/select,${target}`], 'the file manager');
  else launch('xdg-open', [path.dirname(target)], 'the file manager');
}

/** Opens `target` with whatever the desktop uses for it: the default video player, or the folder. */
export function openWithDefaultApp(target: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') launch('open', [target], 'the file');
  else if (platform === 'win32') launch('cmd.exe', ['/c', 'start', '', target], 'the file');
  else launch('xdg-open', [target], 'the file');
}
