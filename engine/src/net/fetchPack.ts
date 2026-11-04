/**
 * Every pack goes through here: priority hints, abort, and a byte count taken from
 * the stream itself so progress is accurate on any connection.
 */
export class PackError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`pack ${url} answered ${status}`);
    this.name = "PackError";
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  priority?: "high" | "low" | "auto";
  /** Called for each chunk with its length. */
  onBytes?: (n: number) => void;
  /** Known size, so the buffer is allocated once. */
  expected?: number;
}

export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    signal: opts.signal,
    priority: opts.priority ?? "auto",
    credentials: "omit",
  } as RequestInit);
  if (!res.ok) throw new PackError(url, res.status);
  if (!res.body) {
    const all = await res.arrayBuffer();
    opts.onBytes?.(all.byteLength);
    return all;
  }
  const reader = res.body.getReader();
  let out = new Uint8Array(opts.expected && opts.expected > 0 ? opts.expected : 65536);
  let used = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (used + value.length > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, used + value.length));
      grown.set(out.subarray(0, used));
      out = grown;
    }
    out.set(value, used);
    used += value.length;
    opts.onBytes?.(value.length);
  }
  return used === out.length ? out.buffer : out.buffer.slice(0, used);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const bytes = await fetchBytes(url, opts);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/** Gives the browser a turn between steps, so a load never holds the main thread. */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}
