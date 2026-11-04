import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { isSessionActive, UnauthorizedError } from "@semprec/data";
import { BACKPRESSURE_CLOSE_CODE, sendWithBackpressure, SESSION_REVOKED_CLOSE_CODE } from "@semprec/realtime";
import { runAsSystem } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { isAllowedOrigin } from "./originCheck.js";
import { logger } from "./logger.js";

const controlSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("start"), language: z.string().min(1).max(35), threadId: z.string().uuid().optional() })
    .strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);
const outboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("transcript"), text: z.string(), final: z.boolean() }).strict(),
  z.object({ type: z.literal("speaking"), state: z.enum(["started", "stopped"]) }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum([
        "budgetExceeded",
        "sessionLimit",
        "idleTimeout",
        "overloaded",
        "durationLimit",
        "invalidFrame",
        "unavailable",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("end") }).strict(),
]);
type Control = z.infer<typeof controlSchema>;
type Outbound = z.infer<typeof outboundSchema>;
export interface VoiceIdentity {
  tenantId: string;
  userId: string;
  sessionId: string;
}
export interface VoiceSender {
  sendControl(frame: Outbound): boolean;
  sendAudio(pcm: Buffer): boolean;
}
export interface VoiceSessionHandler {
  onStart(
    identity: VoiceIdentity,
    frame: Extract<Control, { type: "start" }>,
    sender: VoiceSender,
  ): void | Promise<void>;
  onAudio(identity: VoiceIdentity, pcm: Buffer): void | boolean | Promise<void | boolean>;
  onControl(identity: VoiceIdentity, frame: Extract<Control, { type: "stop" | "end" }>): void | Promise<void>;
  onClose(identity: VoiceIdentity): void | Promise<void>;
}
export interface VoiceChannel {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  closeTenant(tenantId: string): void;
  close(): Promise<void>;
}
interface Options {
  handler?: VoiceSessionHandler;
  idleTimeoutMs?: number;
  sessionTimeoutMs?: number;
  revalidateIntervalMs?: number;
  authenticate?: (req: IncomingMessage) => Promise<VoiceIdentity | null>;
  revalidate?: (sessionId: string) => Promise<boolean>;
}
function reject(socket: Duplex, status: 401 | 403 | 503): void {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}
function bytes(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

export function createVoiceChannel(pool: Pool, options: Options = {}): VoiceChannel {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const identities = new Map<WebSocket, VoiceIdentity>();
  const users = new Map<string, WebSocket>();
  const pending = new Set<Duplex>();
  const tenantClosures = new Map<string, number>();
  let generation = 0,
    closed = false;
  let closing: Promise<void> | undefined;
  const authenticate =
    options.authenticate ??
    (async (req: IncomingMessage) => {
      try {
        const i = await authenticateRequest(pool, req);
        return { tenantId: i.tenantId, userId: i.user.id, sessionId: i.session.id };
      } catch (err) {
        if (err instanceof UnauthorizedError) return null;
        throw err;
      }
    });
  const revalidate = options.revalidate ?? ((id: string) => isSessionActive(pool, id));
  function attach(ws: WebSocket, identity: VoiceIdentity): void {
    identities.set(ws, identity);
    users.set(identity.userId, ws);
    let started = false,
      busy = false,
      checking = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    const send = (payload: string | Buffer): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const size = typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
      if (ws.bufferedAmount + size > 256 * 1024) {
        const errorFrame = JSON.stringify({ type: "error", code: "overloaded" });
        if (ws.bufferedAmount + Buffer.byteLength(errorFrame) <= 256 * 1024) sendWithBackpressure(ws, errorFrame);
        ws.close(BACKPRESSURE_CLOSE_CODE, "overloaded");
        return false;
      }
      sendWithBackpressure(ws, payload);
      return ws.readyState === WebSocket.OPEN;
    };
    const sender: VoiceSender = {
      sendControl(frame) {
        const parsed = outboundSchema.safeParse(frame);
        if (!parsed.success) throw new Error("Invalid voice server control");
        const payload = JSON.stringify(parsed.data);
        if (Buffer.byteLength(payload) > 4096) throw new Error("Voice server control exceeds frame limit");
        return send(payload);
      },
      sendAudio(pcm) {
        if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > 4800 || pcm.length % 2 !== 0)
          throw new Error("Invalid voice speech frame");
        return send(Buffer.concat([Buffer.from([2]), pcm]));
      },
    };
    const fail = (code: Extract<Outbound, { type: "error" }>["code"], closeCode: number) => {
      sender.sendControl({ type: "error", code });
      if (ws.readyState === WebSocket.OPEN) ws.close(closeCode, code);
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail("idleTimeout", 1008), options.idleTimeoutMs ?? 60_000);
    };
    const duration = setTimeout(() => fail("durationLimit", 1008), options.sessionTimeoutMs ?? 30 * 60_000);
    const heartbeat = setInterval(() => {
      if (checking || ws.readyState !== WebSocket.OPEN) return;
      checking = true;
      runAsSystem("voice:revalidate", () => revalidate(identity.sessionId))
        .then(
          (active) => {
            if (!active && ws.readyState === WebSocket.OPEN) ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
          },
          (err: unknown) => {
            logger.warn(
              { errorName: err instanceof Error ? err.name : typeof err },
              "Voice session revalidation failed",
            );
            if (ws.readyState === WebSocket.OPEN) ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
          },
        )
        .finally(() => {
          checking = false;
        });
    }, options.revalidateIntervalMs ?? 30_000);
    resetIdle();
    ws.on("error", (err: unknown) =>
      logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "Voice socket error"),
    );
    ws.on("close", () => {
      clearTimeout(idleTimer);
      clearTimeout(duration);
      clearInterval(heartbeat);
      identities.delete(ws);
      if (users.get(identity.userId) === ws) users.delete(identity.userId);
      if (options.handler)
        Promise.resolve()
          .then(() => options.handler?.onClose(identity))
          .catch(() => logger.warn("Voice handler close failed"));
    });
    if (!options.handler) {
      fail("unavailable", 1011);
      return;
    }
    const handler = options.handler;
    ws.on("message", (data, binary) => {
      if (busy) {
        fail("overloaded", BACKPRESSURE_CLOSE_CODE);
        return;
      }
      const payload = bytes(data);
      resetIdle();
      let operation: () => void | boolean | Promise<void | boolean>;
      let ending = false;
      if (binary) {
        if (
          !started ||
          payload.length < 641 ||
          payload.length > 3201 ||
          payload[0] !== 1 ||
          (payload.length - 1) % 2 !== 0
        ) {
          fail("invalidFrame", 1002);
          return;
        }
        operation = () => handler.onAudio(identity, payload.subarray(1));
      } else {
        if (payload.length > 4096) {
          fail("invalidFrame", 1009);
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(payload.toString("utf8"));
        } catch {
          fail("invalidFrame", 1002);
          return;
        }
        const parsed = controlSchema.safeParse(raw);
        if (
          !parsed.success ||
          (parsed.data.type === "start" && started) ||
          (parsed.data.type !== "start" && !started)
        ) {
          fail("invalidFrame", 1002);
          return;
        }
        const frame = parsed.data;
        if (frame.type === "start") {
          started = true;
          operation = () => handler.onStart(identity, frame, sender);
        } else {
          ending = frame.type === "end";
          operation = () => handler.onControl(identity, frame);
        }
      }
      busy = true;
      Promise.resolve()
        .then(operation)
        .then(
          (accepted) => {
            if (accepted === false) fail("overloaded", BACKPRESSURE_CLOSE_CODE);
            else if (ending && ws.readyState === WebSocket.OPEN) {
              sender.sendControl({ type: "end" });
              ws.close(1000, "end");
            }
          },
          () => fail("unavailable", 1011),
        )
        .finally(() => {
          busy = false;
        });
    });
  }
  return {
    handleUpgrade(req, socket, head) {
      if (!isAllowedOrigin(req)) {
        reject(socket, 403);
        return;
      }
      if (closed) {
        reject(socket, 503);
        return;
      }
      const atStart = generation;
      pending.add(socket);
      socket.once("close", () => pending.delete(socket));
      socket.once("error", (err: unknown) => {
        pending.delete(socket);
        logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "Voice upgrade socket error");
      });
      runAsSystem("voice:upgrade", () => authenticate(req))
        .then((identity) => {
          pending.delete(socket);
          if (!identity) {
            reject(socket, 401);
            return;
          }
          if (closed || socket.destroyed) {
            reject(socket, 503);
            return;
          }
          if ((tenantClosures.get(identity.tenantId) ?? 0) > atStart) {
            reject(socket, 401);
            return;
          }
          if (users.has(identity.userId)) {
            wss.handleUpgrade(req, socket, head, (ws) => {
              ws.on("error", () => {});
              sendWithBackpressure(ws, JSON.stringify({ type: "error", code: "sessionLimit" }));
              ws.close(1008, "sessionLimit");
            });
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => attach(ws, identity));
        })
        .catch((err: unknown) => {
          pending.delete(socket);
          logger.error(
            { errorName: err instanceof Error ? err.name : typeof err },
            "Voice upgrade authentication failed",
          );
          reject(socket, 401);
        });
    },
    closeTenant(tenantId) {
      tenantClosures.set(tenantId, ++generation);
      for (const [ws, identity] of identities)
        if (identity.tenantId === tenantId && ws.readyState === WebSocket.OPEN)
          ws.close(SESSION_REVOKED_CLOSE_CODE, "account deactivated");
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of pending) socket.destroy();
      pending.clear();
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.close(1012, "server shutting down");
      closing = new Promise<void>((resolve, rejectClose) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          for (const ws of wss.clients) ws.terminate();
          resolve();
        }, 1000);
        wss.close((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) rejectClose(err);
          else resolve();
        });
      });
      return closing;
    },
  };
}
