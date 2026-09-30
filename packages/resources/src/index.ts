import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';

export interface ResourceState {
  at: number; paused: boolean; reason?: string; cpuPercent?: number;
  downloadKbps?: number; uploadKbps?: number; preempted?: Record<string, number>;
  memoryMb?: number; metrics?: { ownMemoryMb: number };
}
export function resourceState(file = process.env.MEDIA_RESOURCE_STATE): ResourceState {
  if (!file) return { at: Date.now(), paused: false };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as ResourceState;
    if (typeof state.paused !== 'boolean' || !Number.isFinite(state.at) || Date.now()-state.at > 10000)
      return { ...state, paused: true, reason: 'governor-offline' };
    return state;
  } catch { return { at: 0, paused: true, reason: 'governor-offline' }; }
}
export async function waitForResources(cancelled?: () => Promise<boolean>, headroomMb = 0): Promise<void> {
  for (;;) {
    const state = resourceState();
    const available = (state.memoryMb ?? 0) - (state.metrics?.ownMemoryMb ?? 0);
    if (!state.paused && (!process.env.MEDIA_RESOURCE_STATE || available >= headroomMb)) return;
    if (await cancelled?.()) throw new Error('Задание отменено');
    await delay(500);
  }
}
export function wasPreempted(pid: number | undefined, started: number): boolean {
  return pid !== undefined && (resourceState().preempted?.[String(pid)] ?? 0) >= started;
}
/** Stage deadlines count actual working time, excluding desktop preemption. */
export function activeTimeout(callback: () => void, ms: number): ReturnType<typeof setInterval> {
  let remaining = ms, previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (!resourceState().paused) remaining -= now-previous;
    previous = now;
    if (remaining <= 0) { clearInterval(timer); callback(); }
  }, Math.min(250, ms));
  return timer;
}
export class ResourcePauseError extends Error {
  constructor() { super('Передача приостановлена для других программ'); this.name='ResourcePauseError'; }
}
/** Close the socket on activity rather than leaving a stalled connection open. */
export async function resourceRequest<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs=600000): Promise<T> {
  await waitForResources();
  const controller = new AbortController();
  const deadline = activeTimeout(()=>controller.abort(new Error('Network transfer timeout')),timeoutMs);
  const monitor = setInterval(()=>{if(resourceState().paused)controller.abort(new ResourcePauseError());},250);
  try { return await request(controller.signal); }
  catch(error) { if(controller.signal.reason instanceof ResourcePauseError)throw controller.signal.reason; throw error; }
  finally { clearInterval(monitor);clearInterval(deadline); }
}
/** One shared direction budget per worker, no per-file multiplication/burst. */
export class ByteBudget {
  private lane: Promise<void> = Promise.resolve();
  constructor(private readonly direction: 'upload'|'download', private readonly read = resourceState) {}
  consume(bytes: number, ceiling: number, signal?: AbortSignal): Promise<void> {
    const run = async () => {
      let left = bytes;
      while (left > 0) {
        signal?.throwIfAborted();
        const state = this.read();
        if (state.paused) { await delay(100,undefined,{signal}); continue; }
        const kbps = this.direction === 'upload' ? state.uploadKbps : state.downloadKbps;
        const speed = Math.min(ceiling || Infinity, kbps ? kbps*125 : Infinity);
        if (!Number.isFinite(speed)) return;
        if (speed <= 0) throw new Error('Invalid network budget');
        const slice = Math.min(left, speed*.1);
        await delay(slice*1000/speed,undefined,{signal});
        left -= slice;
      }
    };
    const next = this.lane.then(run, run);
    this.lane = next.catch(() => {});
    return next;
  }
}
const budgets = { upload: new ByteBudget('upload'), download: new ByteBudget('download') };
export function pacedStream(source: Readable, direction: 'upload'|'download', ceiling = 0): Readable {
  const controller = new AbortController();
  async function* chunks() {
    try {
      for await (const chunk of source) {
        // Bound both buffering and the largest burst to 16 KiB.
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < data.length; offset += 16384) {
          const piece = data.subarray(offset, offset+16384);
          await budgets[direction].consume(piece.length, ceiling, controller.signal);
          yield piece;
        }
      }
    } finally { source.destroy(); }
  }
  const output = Readable.from(chunks(), { objectMode: false, highWaterMark: 16384 });
  output.once('close',()=>{controller.abort();source.destroy();});
  return output;
}
