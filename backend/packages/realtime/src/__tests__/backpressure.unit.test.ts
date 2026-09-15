import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { BACKPRESSURE_CLOSE_CODE, MAX_BUFFERED_BYTES, sendWithBackpressure } from "../backpressure.js";

/** A minimal double satisfying just the surface `sendWithBackpressure` touches. */
function fakeSocket(overrides: Partial<Pick<WebSocket, "readyState" | "bufferedAmount">> = {}): {
  ws: WebSocket;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const close = vi.fn();
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send,
    close,
    ...overrides,
  } as unknown as WebSocket;
  return { ws, send, close };
}

describe("sendWithBackpressure (issue #242)", () => {
  it("sends normally when the outgoing buffer is under the threshold", () => {
    const { ws, send, close } = fakeSocket({ bufferedAmount: 1_000 });
    sendWithBackpressure(ws, "payload");
    expect(send).toHaveBeenCalledWith("payload");
    expect(close).not.toHaveBeenCalled();
  });

  it("closes with 1013 instead of sending once the outgoing buffer exceeds the threshold — never silently dropping the frame by skipping it", () => {
    const { ws, send, close } = fakeSocket({ bufferedAmount: MAX_BUFFERED_BYTES + 1 });
    sendWithBackpressure(ws, "payload");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(BACKPRESSURE_CLOSE_CODE, expect.any(String));
  });

  it("does nothing for a socket that is not open, rather than sending into a closing connection", () => {
    const { ws, send, close } = fakeSocket({ readyState: 3, bufferedAmount: 0 });
    sendWithBackpressure(ws, "payload");
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
