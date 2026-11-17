/** Bounds resident memory, not throughput: each request can hold several copies of a large body. */
export const MAX_CONCURRENT_AUDIO_REQUESTS = 2;

/** Each release function frees its slot at most once, however often it is called. */
export function createAudioConcurrencyLimit(max: number): { tryAcquire(): (() => void) | null; inFlight(): number } {
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= max) return null;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
    inFlight() {
      return inFlight;
    },
  };
}
