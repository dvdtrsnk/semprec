import type { OutboundFrame } from "./protocolV1.js";

type DocFrame = Extract<OutboundFrame, { type: "invalidate"; scope: "doc" }>;
type Entry = {
  tenantId: string;
  docId: string;
  dirty: boolean;
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lookup: Promise<void> | null;
};

/** Coalesces signals into a leading read and a fresh read at a dirty trailing boundary. */
export function createDocInvalidationThrottle(
  resolve: (tenantId: string, docId: string) => Promise<DocFrame | null>,
  send: (tenantId: string, frame: DocFrame) => void,
  reportFailure: () => void,
) {
  const entries = new Map<string, Entry>();
  let closed = false;

  function schedule(key: string, entry: Entry): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (closed) return;
      if (entry.dirty) {
        if (entry.lookup) entry.due = true;
        else startLookup(key, entry);
      } else if (entry.lookup) {
        entry.due = true;
      } else {
        entries.delete(key);
      }
    }, 1000);
  }

  function startLookup(key: string, entry: Entry): void {
    if (closed) return;
    entry.dirty = false;
    entry.due = false;
    if (!entry.timer) schedule(key, entry);
    const lookup = Promise.resolve()
      .then(() => (closed ? null : resolve(entry.tenantId, entry.docId)))
      .then((frame) => {
        if (!closed && frame) send(entry.tenantId, frame);
      })
      .catch(() => reportFailure())
      .finally(() => {
        entry.lookup = null;
        if (closed) return;
        if (entry.due && entry.dirty) startLookup(key, entry);
        else if (!entry.timer && !entry.dirty) entries.delete(key);
      });
    entry.lookup = lookup;
  }

  return {
    enqueue(tenantId: string, docId: string): void {
      if (closed) return;
      const key = JSON.stringify([tenantId, docId]);
      const existing = entries.get(key);
      if (existing) {
        existing.dirty = true;
        return;
      }
      const entry: Entry = { tenantId, docId, dirty: false, due: false, timer: null, lookup: null };
      entries.set(key, entry);
      startLookup(key, entry);
    },
    async close(): Promise<void> {
      closed = true;
      const lookups: Promise<void>[] = [];
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.lookup) lookups.push(entry.lookup);
      }
      await Promise.all(lookups);
      entries.clear();
    },
  };
}
