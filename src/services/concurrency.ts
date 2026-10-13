/**
 * Run an async mapper over items with a bounded concurrency, preserving order.
 * Lets us fire several VTOP requests at once (instead of awaiting each in turn)
 * while staying polite to the server. `limit` caps simultaneous in-flight calls.
 */
export async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = 6,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
