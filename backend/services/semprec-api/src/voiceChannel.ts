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
  readonly signal: AbortSignal;
  sendControl(frame: Outbound): boolean;
  sendAudio(pcm: Buffer): boolean;
  fail(code: Extract<Outbound, { type: "error" }>["code"]): void;
}
export interface VoiceSessionHandler {
  onStart(
    identity: VoiceIdentity,
    frame: Extract<Control, { type: "start" }>,
    sender: VoiceSender,
  ): void | Promise<void>;
  onAudio(identity: VoiceIdentity, pcm: Buffer): void | boolean | Promise<void | boolean>;
  onControl(identity: VoiceIdentity, frame: Extract<Control, { type: "stop" | "end" }>): void | Promise<void>;
  onClose(
    identity: VoiceIdentity,
  ):
    | void
    | { readonly operationFailures: readonly unknown[] }
    | Promise<void | { readonly operationFailures: readonly unknown[] }>;
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
  interface Slot {
    ws: WebSocket;
    identity: VoiceIdentity;
    controller: AbortController;
    active: Promise<void> | null;
    cleanupStarted: boolean;
    failures: Array<"operation" | "cleanup">;
    settled: Promise<void>;
    resolveSettled: () => void;
  }
  const users = new Map<string, Slot>();
  const slots = new Set<Slot>();
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
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const slot: Slot = {
      ws,
      identity,
      controller: new AbortController(),
      active: null,
      cleanupStarted: false,
      failures: [],
      settled,
      resolveSettled,
    };
    users.set(identity.userId, slot);
    slots.add(slot);
    let started = false,
      busy = false,
      checking = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    const send = (payload: string | Buffer): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const size = typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
      if (ws.bufferedAmount + size > 256 * 1024) {
        slot.controller.abort();
        const errorFrame = JSON.stringify({ type: "error", code: "overloaded" });
        if (ws.bufferedAmount + Buffer.byteLength(errorFrame) <= 256 * 1024) sendWithBackpressure(ws, errorFrame);
        ws.close(BACKPRESSURE_CLOSE_CODE, "overloaded");
        return false;
      }
      sendWithBackpressure(ws, payload);
      return ws.readyState === WebSocket.OPEN;
    };
    const sender: VoiceSender = {
      signal: slot.controller.signal,
      sendControl(frame) {
        if (slot.controller.signal.aborted) return false;
        const parsed = outboundSchema.safeParse(frame);
        if (!parsed.success) throw new Error("Invalid voice server control");
        const payload = JSON.stringify(parsed.data);
        if (Buffer.byteLength(payload) > 4096) throw new Error("Voice server control exceeds frame limit");
        return send(payload);
      },
      fail(code) {
        fail(code, 1008);
      },
      sendAudio(pcm) {
        if (slot.controller.signal.aborted) return false;
        if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > 4800 || pcm.length % 2 !== 0)
          throw new Error("Invalid voice speech frame");
        return send(Buffer.concat([Buffer.from([2]), pcm]));
      },
    };
    const fail = (code: Extract<Outbound, { type: "error" }>["code"], closeCode: number) => {
      if (slot.controller.signal.aborted) return;
      slot.controller.abort();
      send(JSON.stringify({ type: "error", code }));
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
            if (!active && ws.readyState === WebSocket.OPEN) {
              slot.controller.abort();
              ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
            }
          },
          (err: unknown) => {
            logger.warn(
              { errorName: err instanceof Error ? err.name : typeof err },
              "Voice session revalidation failed",
            );
            if (ws.readyState === WebSocket.OPEN) {
              slot.controller.abort();
              ws.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
            }
          },
        )
        .finally(() => {
          checking = false;
        });
    }, options.revalidateIntervalMs ?? 30_000);
    resetIdle();
    ws.on("error", (err: unknown) => {
      slot.controller.abort();
      logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "Voice socket error");
    });
    ws.on("close", () => {
      slot.controller.abort();
      clearTimeout(idleTimer);
      clearTimeout(duration);
      clearInterval(heartbeat);
      identities.delete(ws);
      if (slot.cleanupStarted) return;
      slot.cleanupStarted = true;
      Promise.resolve(slot.active)
        .then(() => options.handler?.onClose(identity))
        .then(
          () => {
            if (users.get(identity.userId) === slot) users.delete(identity.userId);
            slots.delete(slot);
            slot.resolveSettled();
          },
          (err: unknown) => {
            slot.failures.push("cleanup");
            logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "Voice handler close failed");
            slot.resolveSettled();
          },
        );
    });
    if (!options.handler) {
      fail("unavailable", 1011);
      return;
    }
    const handler = options.handler;
    ws.on("message", (data, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
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
      const completed = (accepted: void | boolean) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (accepted === false) fail("overloaded", BACKPRESSURE_CLOSE_CODE);
        else if (ending) {
          sender.sendControl({ type: "end" });
          slot.controller.abort();
          ws.close(1000, "end");
        }
      };
      const failed = (err: unknown) => {
        slot.failures.push("operation");
        logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "Voice handler operation failed");
        if (ws.readyState === WebSocket.OPEN) fail("unavailable", 1011);
      };
      try {
        const result = operation();
        if (result instanceof Promise) {
          busy = true;
          const active = result
            .then(completed)
            .catch(failed)
            .finally(() => {
              busy = false;
            });
          slot.active = active;
          void active.then(() => {
            if (slot.active === active) slot.active = null;
          });
        } else completed(result);
      } catch (err) {
        failed(err);
      }
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
      for (const slot of slots) {
        if (slot.identity.tenantId !== tenantId) continue;
        slot.controller.abort();
        if (slot.ws.readyState === WebSocket.OPEN) slot.ws.close(SESSION_REVOKED_CLOSE_CODE, "account deactivated");
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const socket of pending) socket.destroy();
      pending.clear();
      for (const slot of slots) slot.controller.abort();
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.close(1012, "server shutting down");
      const owned = [...slots];
      closing = new Promise<void>((resolve, rejectClose) => {
        let finished = false;
        let serverError: Error | undefined;
        const errors = (timedOut: boolean): Error[] => {
          const result: Error[] = [];
          if (serverError) result.push(serverError);
          for (const slot of owned)
            for (const failure of slot.failures) result.push(new Error(`Voice handler ${failure} failed`));
          if (timedOut) result.push(new Error("Voice shutdown timed out with unsettled work"));
          return result;
        };
        const finish = (timedOut: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const failures = errors(timedOut);
          if (failures.length) rejectClose(new AggregateError(failures, "Voice shutdown did not settle cleanly"));
          else resolve();
        };
        const timer = setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          finish(true);
        }, 1000);
        wss.close((err) => {
          if (err) serverError = err;
          Promise.all(owned.map((slot) => slot.settled))
            .then(() => finish(false))
            .catch((error: unknown) => {
              serverError = error instanceof Error ? error : new Error("Voice settlement failed", { cause: error });
              finish(false);
            });
        });
      });
      return closing;
    },
  };
}
