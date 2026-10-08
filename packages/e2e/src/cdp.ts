/** A minimal Chrome DevTools Protocol client on Node's built-in WebSocket; no dependencies. */

type Listener = (message: { method: string; params: unknown; sessionId?: string }) => void;

export class Cdp {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners: Listener[] = [];

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    let url = '';
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        url = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!url) throw new Error('Chrome did not open its debugging port');
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket error'));
    });
    ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        sessionId?: string;
        error?: unknown;
        result?: unknown;
      };
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(JSON.stringify(m.error)));
        else p?.resolve(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l({ method: m.method, params: m.params, sessionId: m.sessionId });
      }
    };
    this.ws = ws;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws?.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(listener: Listener): void {
    this.listeners.push(listener);
  }

  waitFor(method: string, sessionId?: string): Promise<unknown> {
    return new Promise((resolve) => {
      const l: Listener = (m) => {
        if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
          this.listeners.splice(this.listeners.indexOf(l), 1);
          resolve(m.params);
        }
      };
      this.listeners.push(l);
    });
  }

  close(): void {
    this.ws?.close();
  }
}
