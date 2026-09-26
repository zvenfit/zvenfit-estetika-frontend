// Shared error traversal without a dependency on logging or a storage provider.
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current) && chain.length < 4) {
    chain.push(current);
    visited.add(current);
    current = (current as Record<string, unknown>).cause;
  }

  return chain;
}
