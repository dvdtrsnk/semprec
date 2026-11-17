import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  sockets: [] as Array<{
    emit(event: string, ...args: unknown[]): boolean;
    open(): void;
    terminated: boolean;
    sent: string[];
    bufferedAmount: number;
    readyState: number;
    failSend: boolean;
  }>,
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    failSend = false;
    terminated = false;
    sent: string[] = [];
    constructor() {
      super();
      state.sockets.push(this);
    }
    send(value: string): void {
      if (this.failSend) throw new Error("private transport detail");
      this.sent.push(value);
    }
    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }
    terminate(): void {
      this.terminated = true;
      this.readyState = 3;
    }
  }
  return { WebSocket: FakeWebSocket };
});
import { createOpenAiStreamingTranscriptionProvider } from "../openAiStreamingTranscriptionProvider.js";
const events = () => ({ onPartial: vi.fn(), onFinal: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
describe("OpenAI streaming transcription adapter", () => {
  beforeEach(() => {
    state.sockets.length = 0;
  });
  it("rejects a pending open and terminates its socket when aborted", async () => {
    const controller = new AbortController();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({
      events: events(),
      signal: controller.signal,
    });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    controller.abort();
    await expect(opening).rejects.toThrow("OpenAI session aborted before it opened");
    expect(socket.terminated).toBe(true);
  });
  it("rejects an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOpenAiStreamingTranscriptionProvider("unused").open({ events: events(), signal: controller.signal }),
    ).rejects.toThrow("OpenAI session aborted before it opened");
    expect(state.sockets[0]?.terminated).toBe(true);
  });
  it("decodes provider messages in each ws data representation and aborts an opened session", async () => {
    const controller = new AbortController();
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({
      events: received,
      signal: controller.signal,
    });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.open();
    const session = await opening;
    const initial: unknown = JSON.parse(socket.sent[0] ?? "null");
    expect(initial).toMatchObject({
      type: "transcription_session.update",
      session: { input_audio_format: "pcm16", input_audio_transcription: { model: "gpt-4o-transcribe" } },
    });
    const data = Buffer.from(
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "hello" }),
    );
    for (const raw of [data, [data.subarray(0, 8), data.subarray(8)], Uint8Array.from(data).buffer]) {
      socket.emit("message", raw, false);
    }
    expect(received.onPartial.mock.calls).toEqual([["hello"], ["hellohello"], ["hellohellohello"]]);
    controller.abort();
    expect(socket.terminated).toBe(true);
    session.abort();
    expect(received.onError).not.toHaveBeenCalled();
  });
  it("sends resampled audio and finishes only after the provider completes the committed item", async () => {
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: received, language: "cs" });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.open();
    const session = await opening;
    const initial: unknown = JSON.parse(socket.sent[0] ?? "null");
    expect(initial).toMatchObject({ session: { input_audio_transcription: { language: "cs" } } });
    session.write(Buffer.alloc(8));
    session.end();
    const append: unknown = JSON.parse(socket.sent[1] ?? "null");
    const commit: unknown = JSON.parse(socket.sent[2] ?? "null");
    expect(append).toEqual({ type: "input_audio_buffer.append", audio: Buffer.alloc(10).toString("base64") });
    expect(commit).toEqual({ type: "input_audio_buffer.commit" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.committed" })), false);
    expect(received.onDone).not.toHaveBeenCalled();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "a",
          transcript: "finished",
        }),
      ),
      false,
    );
    expect(received.onFinal).toHaveBeenCalledWith("finished");
    expect(received.onDone).toHaveBeenCalledOnce();
    expect(socket.terminated).toBe(true);
  });

  it("rejects an overflowing configuration before resolving the session", async () => {
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: received });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.bufferedAmount = 256 * 1024;
    socket.open();
    await expect(opening).rejects.toThrow("Speech provider outbound buffer unavailable");
    expect(socket.sent).toEqual([]);
    expect(socket.terminated).toBe(true);
    expect(received.onError).not.toHaveBeenCalled();
  });

  it("allows configuration at exactly the byte limit", async () => {
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: events() });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    const configuration = JSON.stringify({
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: { model: "gpt-4o-transcribe" },
        turn_detection: { type: "server_vad" },
      },
    });
    socket.bufferedAmount = 256 * 1024 - Buffer.byteLength(configuration, "utf8");
    socket.open();
    const session = await opening;
    expect(socket.sent).toEqual([configuration]);
    session.abort();
  });

  it("rejects a configuration send failure with a fixed error", async () => {
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: events() });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.failSend = true;
    socket.open();
    await expect(opening).rejects.toThrow("Speech provider outbound buffer unavailable");
    expect(socket.sent).toEqual([]);
    expect(socket.terminated).toBe(true);
  });

  it("allows exactly the limit and fails once before an overflowing audio frame", async () => {
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: received });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.open();
    const session = await opening;
    const frame = JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(10).toString("base64") });
    socket.bufferedAmount = 256 * 1024 - Buffer.byteLength(frame, "utf8");
    session.write(Buffer.alloc(8));
    expect(socket.sent[1]).toBe(frame);
    socket.bufferedAmount += 2;
    session.write(Buffer.alloc(8));
    session.write(Buffer.alloc(8));
    session.end();
    expect(socket.sent).toHaveLength(2);
    expect(received.onError).toHaveBeenCalledOnce();
    expect(received.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Speech provider outbound buffer unavailable" }),
    );
    expect(socket.terminated).toBe(true);
  });

  it("rejects a single oversized audio frame before sending", async () => {
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: received });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.open();
    const session = await opening;
    session.write(Buffer.alloc(200_000));
    expect(socket.sent).toHaveLength(1);
    expect(received.onError).toHaveBeenCalledOnce();
    expect(socket.terminated).toBe(true);
  });

  it("fails instead of sending a commit over the limit", async () => {
    const received = events();
    const opening = createOpenAiStreamingTranscriptionProvider("unused").open({ events: received });
    const socket = state.sockets[0];
    if (!socket) throw new Error("provider did not create a socket");
    socket.open();
    const session = await opening;
    session.write(Buffer.alloc(8));
    socket.bufferedAmount = 256 * 1024;
    session.end();
    expect(socket.sent).toHaveLength(2);
    expect(received.onError).toHaveBeenCalledOnce();
    expect(socket.terminated).toBe(true);
  });
});
