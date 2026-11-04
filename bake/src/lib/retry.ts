/** Runs `attempt` until it reports success, waiting longer each time. Returns the last result. */
export async function untilOk<T>(
  attempt: () => Promise<T>,
  ok: (r: T) => boolean,
  tries = 3,
  waitMs = 15_000,
  onRetry?: (r: T, next: number) => void,
): Promise<T> {
  let r = await attempt();
  for (let t = 1; t < tries && !ok(r); t++) {
    onRetry?.(r, t + 1);
    await new Promise((res) => setTimeout(res, waitMs * t));
    r = await attempt();
  }
  return r;
}
