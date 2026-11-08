/**
 * How many `/internal/diarize` and `/internal/transcribe` requests may be in flight at once. Each
 * one can hold several full copies of a body up to `audioHandler.ts`'s 150 MiB cap, so this bounds
 * the process's resident memory rather than its throughput.
 */
export const MAX_CONCURRENT_AUDIO_REQUESTS = 2;

/**
 * An in-process counter of admitted audio requests. `tryAcquire()` returns a release function
 * while fewer than `max` are in flight, else `null`; each release function frees its slot at most
 * once, however many times it is called.
 */
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
