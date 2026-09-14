const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const FALLBACK_COLOR_COUNT = 6;

/** 32-bit FNV-1a over the UTF-8 bytes of `value`, unsigned overflow throughout. */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** One of `--library-fallback-1..6` (`web/src/styles/tokens.css`), deterministic per stable `itemId`. */
export function libraryFallbackColorVar(itemId: string): string {
  const index = (fnv1a32(itemId) % FALLBACK_COLOR_COUNT) + 1;
  return `var(--library-fallback-${index})`;
}
