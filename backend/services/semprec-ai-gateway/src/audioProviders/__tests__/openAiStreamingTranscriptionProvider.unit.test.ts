import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createOpenAiStreamingTranscriptionProvider,
  Pcm16To24kResampler,
} from "../openAiStreamingTranscriptionProvider.js";

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

function samplesOf(buffer: Buffer): number[] {
  return Array.from({ length: buffer.length / 2 }, (_, index) => buffer.readInt16LE(index * 2));
}

describe("Pcm16To24kResampler", () => {
  it("produces three output samples for every two input samples, interpolating linearly", () => {
    const resampler = new Pcm16To24kResampler();
    // Source positions of output j are 2j/3: 0, 2/3, 4/3, 2, ...
    expect(samplesOf(resampler.push(pcm([0, 300, 600, 900, 1200])))).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it("gives the same samples whether the stream arrives in one frame or in uneven frames", () => {
    const input = Array.from({ length: 60 }, (_, index) => (index * 37) % 1000);
    const whole = samplesOf(new Pcm16To24kResampler().push(pcm(input)));

    const split = new Pcm16To24kResampler();
    const pieces = [input.slice(0, 7), input.slice(7, 8), input.slice(8, 41), input.slice(41)];
    const joined = pieces.flatMap((piece) => samplesOf(split.push(pcm(piece))));

    expect(joined).toEqual(whole);
  });
});

it("uses an injected loopback transport while retaining the real OpenAI session protocol", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  let socket: WebSocket | undefined;
  const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const events: string[] = [];
  try {
    const provider = createOpenAiStreamingTranscriptionProvider("fixture", (url, options) => {
      expect(url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
      expect(options.headers).toEqual({ Authorization: "Bearer fixture", "OpenAI-Beta": "realtime=v1" });
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    });
    const session = await provider.open({
      language: "en",
      events: {
        onPartial: (text) => events.push(`partial:${text}`),
        onFinal: (text) => events.push(`final:${text}`),
        onDone: () => events.push("done"),
        onError: () => events.push("error"),
      },
    });
    socket = await connected;
    socket.send(
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "one", delta: "hello" }),
    );
    socket.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "one",
        transcript: "hello there",
      }),
    );
    await vi.waitFor(() => expect(events).toEqual(["partial:hello", "final:hello there"]));
    session.abort();
  } finally {
    socket?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
