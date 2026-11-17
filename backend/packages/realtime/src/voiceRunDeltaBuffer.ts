import type { AgentStreamMessage } from "./pgNotifyPublisher.js";

const MAX_PENDING = 256;
const MAX_RETAINED = 512 * 1024;
const MAX_ENCODED = 349_528;
const MAX_DECODED = 262_144;
const DEADLINE_MS = 5_000;

type OrderedMessage = AgentStreamMessage & { sempMessageId: string; afterEventId: string; deltaSequence: number };
type Ready = {
  message: OrderedMessage;
  bytes: number;
  since: number;
  chunks?: { id: string; total: number; parts: string[] };
};
type Assembly = { message: OrderedMessage; id: string; total: number; parts: string[]; bytes: number; since: number };

export class VoiceDeltaBufferError extends Error {
  constructor(
    readonly causeCode: "overloaded" | "unavailable",
    message = "Voice delta buffer unavailable",
  ) {
    super(message);
  }
}

/** Pure bounded state for voice-only ordering and chunk decoding. */
export class VoiceRunDeltaBuffer {
  private readonly ready: Ready[] = [];
  private readonly anchors = new Map<string, { next: number; suppressed: boolean }>();
  private assembly: Assembly | undefined;
  private bytes = 0;
  private watermark: string;

  constructor(initialEventId: string) {
    this.watermark = initialEventId;
  }

  get deadline(): number | undefined {
    const times = [...this.ready.map((entry) => entry.since), ...(this.assembly ? [this.assembly.since] : [])];
    return times.length ? Math.min(...times) + DEADLINE_MS : undefined;
  }

  get nextAnchor(): string | undefined {
    const anchors = [...this.ready.map((entry) => entry.message.afterEventId)];
    if (this.assembly) anchors.push(this.assembly.message.afterEventId);
    return anchors.reduce<string | undefined>(
      (first, anchor) => (!first || BigInt(anchor) < BigInt(first) ? anchor : first),
      undefined,
    );
  }

  peek(): OrderedMessage | undefined {
    return this.ready.reduce<Ready | undefined>(
      (first, entry) =>
        !first || BigInt(entry.message.afterEventId) < BigInt(first.message.afterEventId) ? entry : first,
      undefined,
    )?.message;
  }

  shift(): OrderedMessage | undefined {
    const first = this.peek();
    const index = this.ready.findIndex((entry) => entry.message === first);
    const [entry] = index < 0 ? [] : this.ready.splice(index, 1);
    if (entry) this.bytes -= entry.bytes;
    if (!entry?.chunks) return entry?.message;
    const decoded = Buffer.from(entry.chunks.parts.join(""), "base64");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    return { ...entry.message, delta: value };
  }

  advance(eventId: string): void {
    if (BigInt(eventId) <= BigInt(this.watermark)) return;
    this.watermark = eventId;
    for (const anchor of this.anchors.keys()) if (BigInt(anchor) < BigInt(eventId)) this.drop(anchor, false);
  }

  expire(now: number): void {
    const anchors = new Set(
      this.ready.filter((entry) => entry.since + DEADLINE_MS <= now).map((entry) => entry.message.afterEventId),
    );
    if (this.assembly && this.assembly.since + DEADLINE_MS <= now) anchors.add(this.assembly.message.afterEventId);
    for (const anchor of anchors) this.drop(anchor, true);
  }

  clear(): void {
    this.ready.length = 0;
    this.anchors.clear();
    this.assembly = undefined;
    this.bytes = 0;
  }

  admit(message: OrderedMessage, now: number): void {
    this.expire(now);
    const anchor = message.afterEventId;
    if (BigInt(anchor) < BigInt(this.watermark)) return;
    let state = this.anchors.get(anchor);
    if (!state) {
      if (this.anchors.size >= MAX_PENDING) throw new VoiceDeltaBufferError("overloaded");
      state = { next: 1, suppressed: false };
      this.anchors.set(anchor, state);
    }
    if (state.suppressed) return;
    if (message.deltaSequence < state.next) {
      const pending = this.ready.find(
        (entry) => entry.message.afterEventId === anchor && entry.message.deltaSequence === message.deltaSequence,
      );
      if (!pending) return;
      if ("chunk" in message) {
        if (
          !pending.chunks ||
          pending.chunks.id !== message.chunk.id ||
          pending.chunks.total !== message.chunk.total ||
          pending.chunks.parts[message.chunk.index] !== message.delta
        )
          throw new VoiceDeltaBufferError("unavailable");
      } else if (pending.chunks || JSON.stringify(pending.message.delta) !== JSON.stringify(message.delta)) {
        throw new VoiceDeltaBufferError("unavailable");
      }
      return;
    }
    if (
      this.assembly &&
      (this.assembly.message.afterEventId !== anchor || this.assembly.message.deltaSequence !== message.deltaSequence)
    ) {
      this.drop(this.assembly.message.afterEventId, true);
      this.drop(anchor, true);
      return;
    }
    if (message.deltaSequence > state.next) return this.drop(anchor, true);
    if ("chunk" in message) {
      this.admitChunk(message, now, state);
      return;
    }
    if (this.assembly) {
      this.drop(this.assembly.message.afterEventId, true);
      return this.drop(anchor, true);
    }
    const serialized = JSON.stringify(message.delta);
    if (serialized === undefined) throw new VoiceDeltaBufferError("unavailable");
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_DECODED) throw new VoiceDeltaBufferError("overloaded");
    this.reserve(bytes);
    this.ready.push({ message, bytes, since: now });
    state.next++;
  }

  private admitChunk(
    message: OrderedMessage & {
      delta: string;
      chunk: { id: string; index: number; total: number; encoding: "base64json" };
    },
    now: number,
    state: { next: number },
  ): void {
    const { chunk, delta, afterEventId } = message;
    if ((Number.isSafeInteger(chunk.total) && chunk.total > 50) || delta.length > 7000)
      throw new VoiceDeltaBufferError("overloaded");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chunk.id) ||
      !Number.isSafeInteger(chunk.index) ||
      !Number.isSafeInteger(chunk.total) ||
      chunk.total < 1 ||
      chunk.index < 0 ||
      chunk.index >= chunk.total ||
      chunk.encoding !== "base64json" ||
      !/^[A-Za-z0-9+/=]*$/.test(delta)
    )
      throw new VoiceDeltaBufferError("unavailable");
    let assembly = this.assembly;
    if (!assembly) {
      if (chunk.index !== 0) return this.drop(afterEventId, true);
      this.reserve(0);
      assembly = { message, id: chunk.id, total: chunk.total, parts: [], bytes: 0, since: now };
      this.assembly = assembly;
    } else if (
      assembly.message.afterEventId !== afterEventId ||
      assembly.message.deltaSequence !== message.deltaSequence
    ) {
      this.drop(assembly.message.afterEventId, true);
      this.drop(afterEventId, true);
      return;
    } else if (assembly.total !== chunk.total || assembly.id !== chunk.id)
      throw new VoiceDeltaBufferError("unavailable");
    if (chunk.index < assembly.parts.length) {
      if (assembly.parts[chunk.index] !== delta) throw new VoiceDeltaBufferError("unavailable");
      return;
    }
    if (chunk.index !== assembly.parts.length) return this.drop(afterEventId, true);
    if (assembly.bytes + delta.length > MAX_ENCODED || this.bytes + delta.length > MAX_RETAINED)
      throw new VoiceDeltaBufferError("overloaded");
    assembly.parts.push(delta);
    assembly.bytes += delta.length;
    this.bytes += delta.length;
    if (assembly.parts.length !== assembly.total) return;
    const encoded = assembly.parts.join("");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length > MAX_DECODED) throw new VoiceDeltaBufferError("overloaded");
    if (decoded.toString("base64") !== encoded) throw new VoiceDeltaBufferError("unavailable");
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    } catch {
      throw new VoiceDeltaBufferError("unavailable");
    }
    const { chunk: _chunk, ...base } = message;
    this.ready.push({
      message: { ...base, delta: null },
      bytes: assembly.bytes,
      since: assembly.since,
      chunks: { id: assembly.id, total: assembly.total, parts: assembly.parts },
    });
    this.assembly = undefined;
    state.next++;
  }

  private reserve(bytes: number): void {
    if (this.ready.length + (this.assembly ? 1 : 0) >= MAX_PENDING || this.bytes + bytes > MAX_RETAINED)
      throw new VoiceDeltaBufferError("overloaded");
    this.bytes += bytes;
  }

  private drop(anchor: string, suppress: boolean): void {
    for (let index = this.ready.length - 1; index >= 0; index--) {
      const entry = this.ready[index];
      if (entry?.message.afterEventId === anchor) {
        this.bytes -= entry.bytes;
        this.ready.splice(index, 1);
      }
    }
    if (this.assembly?.message.afterEventId === anchor) {
      this.bytes -= this.assembly.bytes;
      this.assembly = undefined;
    }
    if (suppress) this.anchors.set(anchor, { next: 1, suppressed: true });
    else this.anchors.delete(anchor);
  }
}
