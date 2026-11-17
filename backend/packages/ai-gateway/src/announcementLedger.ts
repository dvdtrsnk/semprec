/**
 * Remembers in this process which budget windows already had their first refusal announced. An entry
 * lives until its window ends and is dropped by the next call after that, so there is at most one per
 * key. A restart forgets everything and the announcement repeats once, which is harmless because both
 * things it sends are idempotent.
 */
export class AnnouncementLedger {
  private readonly windowEndsAtMs = new Map<string, number>();

  /** Whether `key` was claimed for a window that is still open at `nowMs`. */
  isAnnounced(key: string, nowMs: number): boolean {
    this.dropEnded(nowMs);
    return this.windowEndsAtMs.has(key);
  }

  /**
   * Claims `key` for the window that ends at `windowEndsAtMs`. Returns `true` to exactly one caller per
   * open window; the check and the claim are one synchronous step, so callers that raced past
   * `isAnnounced` still see a single winner.
   */
  claim(key: string, windowEndsAtMs: number, nowMs: number): boolean {
    this.dropEnded(nowMs);
    if (this.windowEndsAtMs.has(key)) return false;
    this.windowEndsAtMs.set(key, windowEndsAtMs);
    return true;
  }

  /** Forgets a claim whose announcement failed, so the next refusal of the window announces again. */
  release(key: string): void {
    this.windowEndsAtMs.delete(key);
  }

  private dropEnded(nowMs: number): void {
    for (const [key, endsAtMs] of this.windowEndsAtMs) {
      if (endsAtMs <= nowMs) this.windowEndsAtMs.delete(key);
    }
  }
}
