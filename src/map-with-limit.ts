// Caps concurrent Jenkins reads so a wide fan-out does not flood the controller.
export const JENKINS_READ_LIMIT = 6;

/** Maps every item with at most `limit` calls in flight, keeping input order. */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
