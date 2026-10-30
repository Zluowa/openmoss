// Polynomial string hash: `n = (n * 31 + char) % 2147483647`, then `n % paletteLength`.

const CODEX_SPARKLE_HASH_MODULUS = 2_147_483_647;

export const CODEX_SUBAGENT_SPARKLE_COUNT = 28;

export function codexSubagentSparkleIndex(
  seed: string,
  count = CODEX_SUBAGENT_SPARKLE_COUNT,
): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % CODEX_SPARKLE_HASH_MODULUS;
  }
  const size = count > 0 ? count : 1;
  return hash % size;
}
