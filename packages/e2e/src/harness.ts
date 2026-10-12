/**
 * What every end-to-end script needs: the real server with the built client, headless Chrome with a
 * WAV as its microphone, a page attached over the DevTools Protocol, real key and mouse input, and a
 * check collector. No test framework, no dependencies.
 *
 * Nothing here can wait forever. Every call to the browser has a deadline (see cdp.ts), and a script
 * can arm a watchdog for the whole run. When either fires, the script prints what it was doing, the
 * page's console, and a screenshot if the browser still answers, then exits with a failure.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Cdp, DEFAULT_TIMEOUT_MS } from './cdp.js';

export const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ checks */

export const failures: string[] = [];

export function check(condition: boolean, message: string): boolean {
  console.log(`${condition ? '  ok ' : ' FAIL'} ${message}`);
  if (!condition) failures.push(message);
  return condition;
}

/** Prints the verdict and exits: 1 when any check failed, 0 otherwise. */
export function finish(note: string): never {
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`\nall checks passed; ${note}`);
  process.exit(0);
}

/* ------------------------------------------------------------------ ffprobe */

export interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    sample_rate?: string;
  }[];
  format: { duration?: string; format_name?: string };
}

export function probe(file: string): Probe {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate',
    '-show_entries',
    'format=duration,format_name',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(out.toString()) as Probe;
}

export function video(p: Probe): Probe['streams'][number] | undefined {
  return p.streams.find((s) => s.codec_type === 'video');
}

export function audio(p: Probe): Probe['streams'][number] | undefined {
  return p.streams.find((s) => s.codec_type === 'audio');
}

/* ------------------------------------------------------------------ processes */

const children: ChildProcess[] = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** The built server on `port`, saving exports into `exportsDir`; resolves once it answers. */
export async function startServer(port: number, exportsDir: string): Promise<ChildProcess> {
  const server = spawn(
    process.execPath,
    [
      path.join(ROOT, 'packages/server/dist/index.js'),
      '--port',
      String(port),
      '--dir',
      exportsDir,
      // the list of finished exports goes next to the test's output, never into the user's own
      '--data-dir',
      path.join(path.dirname(exportsDir), 'data'),
      '--log-level',
      'warn',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  children.push(server);
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      await sleep(100);
    }
  }
  check(healthy, 'server is up');
  return server;
}

export interface ChromeOptions {
  cdpPort: number;
  profileDir: string;
  /** Played as the microphone. Loops by default; `loop: false` plays it once and then goes silent. */
  wav: string;
  loop?: boolean;
  width?: number;
  height?: number;
}

/** Headless Chrome with a fake microphone and the DevTools port open. */
export function startChrome(options: ChromeOptions): ChildProcess {
  const width = options.width ?? 1400;
  const height = options.height ?? 900;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${options.cdpPort}`,
      `--user-data-dir=${options.profileDir}`,
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${options.wav}${options.loop === false ? '%noloop' : ''}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=AudioServiceSandbox',
    ],
    { stdio: 'ignore' },
  );
  children.push(chrome);
  return chrome;
}

/* ------------------------------------------------------------------ the page */

/**
 * Key names the scripts use, with what the DevTools Protocol wants for each. Letter keys are marked
 * `inPage`: injecting them through `Input.dispatchKeyEvent` makes this Chrome (headless, macOS) emit
 * thousands of trusted keydown events a second that never stop, so they are dispatched as
 * KeyboardEvents inside the page instead, which reaches the app's handler the same way.
 */
const KEYS: Record<string, { code: string; vk: number; text?: string; inPage?: boolean }> = {
  ' ': { code: 'Space', vk: 32, text: ' ' },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  PageDown: { code: 'PageDown', vk: 34 },
  PageUp: { code: 'PageUp', vk: 33 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Escape: { code: 'Escape', vk: 27 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  m: { code: 'KeyM', vk: 77, text: 'm', inPage: true },
  r: { code: 'KeyR', vk: 82, text: 'r', inPage: true },
  z: { code: 'KeyZ', vk: 90, text: 'z', inPage: true },
};

export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export class Page {
  readonly logs: string[] = [];
  private lastStep = 'start';
  private lastStepAt = Date.now();
  private dumping = false;
  private stackDump = false;

  private constructor(
    readonly cdp: Cdp,
    readonly session: string,
    readonly outDir: string,
  ) {}

  /** Connects to Chrome, opens a tab, enables Page/Runtime/Performance and collects console output. */
  static async open(cdpPort: number, outDir: string, size = { width: 1400, height: 900 }): Promise<Page> {
    const cdp = new Cdp(cdpPort);
    await cdp.connect();
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(cdp, sessionId, outDir);
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') {
        const p = m.params as { type: string; args: { value?: unknown; description?: string }[] };
        const text = p.args
          .map((a) => {
            const v = a.value ?? a.description;
            if (v === undefined) return '';
            return typeof v === 'string' ? v : JSON.stringify(v);
          })
          .join(' ');
        page.logs.push(`${p.type}: ${text}`);
      }
      if (m.method === 'Inspector.targetCrashed') {
        page.logs.push('EXCEPTION: the renderer crashed');
        console.error('the renderer crashed');
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } };
        page.logs.push(`EXCEPTION: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
      }
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Inspector.enable');
    await page.send('Performance.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
    process.on('uncaughtException', (error) => void page.dump(error));
    process.on('unhandledRejection', (error) => void page.dump(error));
    return page;
  }

  /** Names the stage the script is in, so a failure or a stall says where it happened. */
  step(label: string): void {
    this.lastStep = label;
    this.lastStepAt = Date.now();
  }

  /** The whole run must be over in `ms`; otherwise it is reported as stalled and the process exits. */
  watchdog(ms: number): void {
    setTimeout(() => {
      void this.dump(new Error(`watchdog: the run did not finish within ${Math.round(ms / 60_000)} min`));
    }, ms);
  }

  /**
   * Lets the dump interrupt the page's JavaScript and print its call stack when the page has
   * stopped answering: the stack shows what the main thread was busy with.
   */
  async enableStackDump(): Promise<void> {
    await this.send('Debugger.enable');
    this.stackDump = true;
  }

  /** Interrupts the page and returns the top of its JavaScript call stack, or null if it will not stop. */
  private async stack(): Promise<string | null> {
    if (!this.stackDump) return null;
    const paused = this.cdp.waitFor('Debugger.paused', this.session, 8_000);
    await this.send('Debugger.pause', {}, 5_000).catch(() => undefined);
    try {
      const p = (await paused) as {
        callFrames: {
          functionName: string;
          url: string;
          location: { lineNumber: number; columnNumber: number };
        }[];
      };
      const lines = p.callFrames
        .slice(0, 12)
        .map(
          (f) =>
            `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() ?? ''}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`,
        );
      await this.send('Debugger.resume', {}, 5_000).catch(() => undefined);
      return lines.join('\n');
    } catch {
      return null;
    }
  }

  /** What went wrong, where the script was, what the page logged, and a last screenshot; then exit 1. */
  async dump(error: unknown): Promise<never> {
    if (this.dumping) return new Promise<never>(() => undefined);
    this.dumping = true;
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.error(`last step: ${this.lastStep} (${Math.round((Date.now() - this.lastStepAt) / 1000)} s ago)`);
    const stack = await this.stack();
    if (stack !== null) console.error(`the page was busy in:\n${stack}`);
    if (this.logs.length) console.error('console:', this.logs.slice(-40).join('\n'));
    try {
      await this.screenshot('stall.png', 5_000);
      console.error(`screenshot: ${path.join(this.outDir, 'stall.png')}`);
    } catch {
      console.error('the browser no longer answers');
    }
    process.exit(1);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.session, timeoutMs);
  }

  /** Evaluates an expression in the page (awaiting a promise) and returns its JSON value. */
  async ev<T = unknown>(expression: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const r = await this.send<{
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails)
      throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Polls an expression until it is truthy; returns whether it became so. */
  async waitFor(expression: string, tries = 50, intervalMs = 100): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      if (await this.ev<boolean>(`Boolean(${expression})`)) return true;
      await sleep(intervalMs);
    }
    return this.ev<boolean>(`Boolean(${expression})`);
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.cdp.waitFor('Page.loadEventFired', this.session);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload(): Promise<void> {
    const loaded = this.cdp.waitFor('Page.loadEventFired', this.session);
    await this.send('Page.reload');
    await loaded;
  }

  /** Waits for the app to boot and (optionally) to have seen the server. */
  async waitForApp(needServer = true): Promise<void> {
    check(await this.waitFor('window.__onetake'), 'app booted');
    if (needServer) check(await this.waitFor('__onetake.serverCaps()'), 'client sees the server');
  }

  /**
   * Starts the mic without waiting on its promise (a microphone that never opens must not hang the
   * script) and reports whether it was armed within `waitMs`.
   */
  async startMic(waitMs = 10_000): Promise<boolean> {
    await this.ev('void __onetake.startMic()');
    return this.waitFor('__onetake.state.armed', Math.round(waitMs / 100), 100);
  }

  async screenshot(name: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const shot = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, timeoutMs);
    fs.writeFileSync(path.join(this.outDir, name), Buffer.from(shot.data, 'base64'));
  }

  /** Puts files into a file input, as if picked in the dialog. */
  async setFiles(selector: string, files: string[]): Promise<void> {
    const { root } = await this.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const { nodeId } = await this.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    await this.send('DOM.setFileInputFiles', { files, nodeId });
  }

  /** One real key event, as the keyboard would send it. */
  async key(
    name: string,
    type: 'keyDown' | 'keyUp',
    options: { repeat?: boolean; modifiers?: number } = {},
  ): Promise<void> {
    const k = KEYS[name];
    if (!k) throw new Error(`unknown key ${name}`);
    const modifiers = options.modifiers ?? 0;
    if (k.inPage) {
      const init = {
        key: name,
        code: k.code,
        repeat: options.repeat ?? false,
        altKey: (modifiers & MODIFIER.alt) !== 0,
        ctrlKey: (modifiers & MODIFIER.ctrl) !== 0,
        metaKey: (modifiers & MODIFIER.meta) !== 0,
        shiftKey: (modifiers & MODIFIER.shift) !== 0,
        bubbles: true,
        cancelable: true,
      };
      // on the focused element (the body when nothing is), where a real key event would land
      await this.ev(
        `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent(${JSON.stringify(type === 'keyDown' ? 'keydown' : 'keyup')}, ${JSON.stringify(init)}))`,
      );
      return;
    }
    const params: Record<string, unknown> = {
      type: type === 'keyDown' && !k.text ? 'rawKeyDown' : type,
      key: name,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      modifiers,
      autoRepeat: options.repeat ?? false,
    };
    if (type === 'keyDown' && k.text && !modifiers) {
      params.text = k.text;
      params.unmodifiedText = k.text;
    }
    await this.send('Input.dispatchKeyEvent', params);
  }

  /** Down and up: a tap. */
  async press(name: string, modifiers = 0): Promise<void> {
    await this.key(name, 'keyDown', { modifiers });
    await this.key(name, 'keyUp', { modifiers });
  }

  /** Centre of an element in page coordinates, or null when it is hidden. */
  async centre(selector: string): Promise<{ x: number; y: number } | null> {
    return this.ev<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
    );
  }

  /** Mouse button down on an element (the browser turns it into pointer events). */
  async mouseDown(selector: string): Promise<boolean> {
    const c = await this.centre(selector);
    if (!c) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: c.x,
      y: c.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    return true;
  }

  async mouseUp(selector: string): Promise<void> {
    const c = (await this.centre(selector)) ?? { x: 10, y: 10 };
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: c.x,
      y: c.y,
      button: 'left',
      clickCount: 1,
    });
  }

  /** V8 heap of the page in megabytes (typed-array backing stores are counted separately by the app). */
  async heapMb(): Promise<number> {
    const { metrics } = await this.send<{ metrics: { name: string; value: number }[] }>(
      'Performance.getMetrics',
    );
    return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1024 / 1024;
  }

  /**
   * Leaves a console breadcrumb around every microphone and Web Audio call the app makes, so when
   * the page stops answering, the dump's last lines say which call it was inside.
   */
  async traceAudio(): Promise<void> {
    await this.ev(`(() => {
      const wrap = (obj, name, label) => { const orig = obj[name]; if (typeof orig !== 'function') return;
        obj[name] = function (...args) { console.info('[audio] ' + label + ' begin'); const r = orig.apply(this, args);
          if (r && typeof r.then === 'function') return r.then((v) => { console.info('[audio] ' + label + ' resolved'); return v; }, (e) => { console.info('[audio] ' + label + ' rejected ' + e); throw e; });
          console.info('[audio] ' + label + ' end'); return r; }; };
      wrap(navigator.mediaDevices, 'getUserMedia', 'getUserMedia');
      wrap(MediaStreamTrack.prototype, 'stop', 'track.stop');
      wrap(AudioNode.prototype, 'disconnect', 'node.disconnect');
      wrap(AudioNode.prototype, 'connect', 'node.connect');
      wrap(AudioContext.prototype, 'resume', 'context.resume');
      wrap(AudioContext.prototype, 'suspend', 'context.suspend');
      wrap(AudioContext.prototype, 'close', 'context.close');
      wrap(AudioContext.prototype, 'createMediaStreamSource', 'createMediaStreamSource');
      wrap(AudioBufferSourceNode.prototype, 'start', 'source.start');
      wrap(AudioBufferSourceNode.prototype, 'stop', 'source.stop');
      wrap(AudioWorklet.prototype, 'addModule', 'worklet.addModule');
      const Orig = window.AudioWorkletNode;
      window.AudioWorkletNode = function (...args) { console.info('[audio] new AudioWorkletNode begin'); const n = new Orig(...args); console.info('[audio] new AudioWorkletNode end'); return n; };
      window.AudioWorkletNode.prototype = Orig.prototype;
    })()`);
  }

  /** Console errors and uncaught exceptions seen so far. */
  errors(): string[] {
    return this.logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('error'));
  }

  close(): void {
    this.cdp.close();
  }
}
