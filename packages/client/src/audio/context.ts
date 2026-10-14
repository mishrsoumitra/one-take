/**
 * The app's one AudioContext, shared by microphone capture and preview playback.
 *
 * One context instead of one per user keeps a single audio graph and a single rendering thread,
 * and it is suspended whenever nothing is using it, so no context is left rendering silence in
 * the background. It runs at 48 kHz whatever the device's own rate: the deep noise filter
 * (`deepfilter.ts`) only works at that rate, and the browser resamples the microphone and the
 * output to and from it.
 */

/** The rate the context runs at; DeepFilterNet3's. */
export const CONTEXT_RATE = 48000;

let context: AudioContext | null = null;
const users = new Set<string>();

export function audioContext(): AudioContext {
  context ??= new AudioContext({ sampleRate: CONTEXT_RATE });
  return context;
}

/** Marks `user` as needing audio and returns the running context. */
export async function acquireAudio(user: string): Promise<AudioContext> {
  users.add(user);
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

/** `user` is done; once nobody needs audio the context is suspended until the next acquire. */
export function releaseAudio(user: string): void {
  users.delete(user);
  if (users.size === 0 && context?.state === 'running') {
    context.suspend().catch(() => {
      /* already closed or closing */
    });
  }
}
