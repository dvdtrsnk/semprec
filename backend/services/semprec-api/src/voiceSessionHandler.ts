import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  openSttStream,
  synthesizeSpeech,
  SpeechSynthesisCapacityError,
  type HttpAiGatewayClientConfig,
  type SttStream,
} from "@semprec/ai-gateway-client";
import {
  getSempThread,
  getSempVoiceDelivery,
  listRunningSempTurnIds,
  requestSempTurnCancel,
  sendSempMessage,
  withTransaction,
  type HeartbeatRuleKindRegistry,
} from "@semprec/data";
import type { SyncServer, VoiceRunFrame } from "@semprec/realtime";
import { AiGatewayFailedError, runInTenant } from "@semprec/shared";
import { DEFAULT_MESSAGE_SPEECH_VOICE } from "./sempSpeechHandler.js";
import type { VoiceIdentity, VoiceSender, VoiceSessionHandler } from "./voiceChannel.js";
import { isVoiceStopCommand } from "./voiceStopCommand.js";

interface Session {
  identity: VoiceIdentity;
  sender: VoiceSender;
  threadId: string | undefined;
  stream: SttStream | undefined;
  streamClosed: Promise<void>;
  resolveStreamClosed(): void;
  admission: Promise<void>;
  work: Promise<void>;
  admissionFailure: { error: unknown } | undefined;
  failures: unknown[];
  queued: number;
  speech: Promise<void>;
  speechController: AbortController | undefined;
  textState: VoiceTextState;
  /**
   * The turn whose answer is being spoken: its run and assistant message, which the speech calls carry so that their
   * usage counts for that reply (issue #2020). Set when a turn begins to be spoken and cleared when the turn ends.
   */
  speechTurn: { runId: string; assistantMessageId: string } | undefined;
  /** The assistant messages this session asked to cancel; a cancelled reply among them ends its turn quietly. */
  stoppedTurns: Set<string>;
  speaking: boolean;
  dispose: (() => Promise<void>) | undefined;
}

const MAX_QUEUED_TURNS = 16;
const MAX_SENTENCES = 32;
const MAX_TEXT = 4000;

class VoiceTextOverloadError extends Error {}
class VoiceTextMismatchError extends Error {}

function isSessionCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return (
    error instanceof Error &&
    error.name === "AbortError" &&
    "code" in error &&
    error.code === "ABORT_ERR" &&
    error.cause === signal.reason
  );
}

/** Bounded, ephemeral sentence and streamed-prefix state for one voice session. */
export class VoiceTextState {
  private hash = createHash("sha256");
  private units = 0;
  private pending = "";
  private readonly sentences: string[] = [];
  private suppressed = false;

  get hasSentences(): boolean {
    return this.sentences.length > 0;
  }
  takeSentence(): string | undefined {
    return this.sentences.shift();
  }
  beginTurn(): void {
    this.suppressed = false;
    this.pending = "";
    this.sentences.length = 0;
    this.resetPrefix();
  }
  interrupt(): void {
    this.suppressed = true;
    this.pending = "";
    this.sentences.length = 0;
    this.resetPrefix();
  }
  pushDelta(text: string): void {
    if (this.suppressed) return;
    const units = this.units + text.length;
    if (!Number.isSafeInteger(units)) throw new VoiceTextOverloadError("Voice text length exceeded");
    this.hash.update(Buffer.from(text, "utf16le"));
    this.units = units;
    this.feed(text, false);
  }
  finishMessage(text: string | undefined): void {
    if (this.suppressed) {
      this.resetPrefix();
      return;
    }
    if (text === undefined) {
      if (this.units !== 0) throw new VoiceTextMismatchError("Voice message text mismatch");
      this.resetPrefix();
      return;
    }
    if (
      text.length < this.units ||
      !createHash("sha256")
        .update(Buffer.from(text.slice(0, this.units), "utf16le"))
        .digest()
        .equals(this.hash.copy().digest())
    )
      throw new VoiceTextMismatchError("Voice message text mismatch");
    this.feed(text.slice(this.units), true);
    this.resetPrefix();
  }
  private resetPrefix(): void {
    this.hash = createHash("sha256");
    this.units = 0;
  }
  private feed(text: string, flush: boolean): void {
    let offset = 0;
    while (offset < text.length) {
      const remaining = text.slice(offset);
      const match = /[.!?](?:\s|$)/u.exec(remaining);
      const length = match ? match.index + match[0].length : remaining.length;
      if (this.pending.length + length > MAX_TEXT) throw new VoiceTextOverloadError("Voice sentence exceeds limit");
      this.pending += remaining.slice(0, length);
      offset += length;
      if (match) this.enqueuePending();
    }
    if (flush && this.pending) this.enqueuePending();
  }
  private enqueuePending(): void {
    const sentence = this.pending;
    this.pending = "";
    if (!sentence.trim()) return;
    if (this.sentences.length >= MAX_SENTENCES) throw new VoiceTextOverloadError("Voice sentence queue exceeds limit");
    this.sentences.push(sentence);
  }
}

/** `heartbeatRuleKinds` resolves the active modules' rule kinds for the thread detail (`resolveModuleRuleKinds`). */
export function createVoiceSessionHandler(
  pool: Pool,
  gateway: HttpAiGatewayClientConfig,
  sync: SyncServer,
  heartbeatRuleKinds: () => Promise<HeartbeatRuleKindRegistry>,
): VoiceSessionHandler {
  const sessions = new Map<string, Session>();
  function fail(session: Session, error: unknown): void {
    if (session.sender.signal.aborted) return;
    session.sender.fail(
      error instanceof SpeechSynthesisCapacityError
        ? "overloaded"
        : error instanceof AiGatewayFailedError && error.reason === "budget_exceeded"
          ? "budgetExceeded"
          : "unavailable",
    );
  }
  function stopSpeech(session: Session): void {
    session.textState.interrupt();
    session.speechController?.abort();
    if (session.speaking) {
      session.speaking = false;
      session.sender.sendControl({ type: "speaking", state: "stopped" });
    }
  }
  /**
   * Handles a stop command: speech output stops at once, and every running turn of the session's thread is asked to
   * cancel. The lookup runs after the admissions already queued, so `threadId` is the thread of the earlier utterances;
   * with no thread or no running turn nothing else happens. The command is never stored as a message.
   */
  function stopCommand(session: Session): void {
    stopSpeech(session);
    const tenantId = session.identity.tenantId;
    session.admission = session.admission
      .then(async () => {
        const threadId = session.threadId;
        if (threadId === undefined || session.sender.signal.aborted) return;
        await runInTenant(tenantId, () =>
          withTransaction(pool, async (client) => {
            for (const assistantMessageId of await listRunningSempTurnIds(client, threadId)) {
              session.stoppedTurns.add(assistantMessageId);
              await requestSempTurnCancel(client, { tenantId, assistantMessageId });
            }
          }),
        );
      })
      .catch((error: unknown) => {
        if (isSessionCancellation(error, session.sender.signal)) return;
        session.failures.push(error);
        fail(session, error);
      });
  }
  function pump(session: Session): void {
    if (session.speechController || session.sender.signal.aborted || !session.textState.hasSentences) return;
    const controller = new AbortController();
    session.speechController = controller;
    const signal = AbortSignal.any([controller.signal, session.sender.signal]);
    session.speech = runInTenant(session.identity.tenantId, async () => {
      while (session.textState.hasSentences && !signal.aborted) {
        const text = session.textState.takeSentence();
        if (!text) continue;
        // Read together with the sentence: the queue holds only the sentences of the turn that is set here.
        const speechTurn = session.speechTurn;
        const audio = await synthesizeSpeech(gateway, {
          text,
          voice: DEFAULT_MESSAGE_SPEECH_VOICE,
          signal,
          ...(speechTurn ? { agentRunId: speechTurn.runId, sempMessageId: speechTurn.assistantMessageId } : {}),
        });
        if (signal.aborted) break;
        if (!session.speaking) {
          session.speaking = true;
          if (!session.sender.sendControl({ type: "speaking", state: "started" })) throw new Error("Voice sink closed");
        }
        let remainder = Buffer.alloc(0);
        for await (const chunk of audio) {
          if (signal.aborted) break;
          const bytes = Buffer.concat([remainder, Buffer.from(chunk)]);
          let offset = 0;
          while (bytes.length - offset >= 2) {
            const length = Math.min(4800, (bytes.length - offset) & ~1);
            if (!session.sender.sendAudio(bytes.subarray(offset, offset + length)))
              throw new Error("Voice sink closed");
            offset += length;
          }
          remainder = Buffer.from(bytes.subarray(offset));
        }
        if (!signal.aborted && remainder.length) throw new Error("Invalid PCM stream");
      }
    })
      .catch((error: unknown) => {
        if (!signal.aborted) fail(session, error);
      })
      .finally(() => {
        if (session.speechController === controller) session.speechController = undefined;
        if (session.speaking) {
          session.speaking = false;
          session.sender.sendControl({ type: "speaking", state: "stopped" });
        }
        if (session.textState.hasSentences && !session.sender.signal.aborted) pump(session);
      });
  }
  async function admit(session: Session, text: string) {
    session.sender.signal.throwIfAborted();
    const result = await runInTenant(session.identity.tenantId, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(
          client,
          { threadId: session.threadId, text, context: [], hasContext: false },
          { source: "voice" },
        ),
      ),
    );
    session.threadId = result.threadId;
    // The speech-to-text rows reserved since the previous question belong to this turn. A stream that is already
    // closed cannot receive the message (the provider finished after the client ended it), so the rows of that
    // last utterance stay unattributed (see the ADR consequences) and a false answer needs no handling.
    session.stream?.attribute(result.assistantMessageId);
    return result;
  }
  async function turn(session: Session, result: Awaited<ReturnType<typeof admit>>): Promise<void> {
    const signal = session.sender.signal;
    signal.throwIfAborted();
    const readDelivery = () =>
      runInTenant(session.identity.tenantId, () =>
        getSempVoiceDelivery(pool, result.threadId, result.assistantMessageId),
      );
    /** True for a reply that ended as the cancellation this session asked for with a stop command. */
    const stoppedByCommand = (reply: Awaited<ReturnType<typeof readDelivery>>): boolean =>
      reply?.status === "error" &&
      reply.errorCode === "cancelled" &&
      session.stoppedTurns.has(result.assistantMessageId);
    let delivery = await readDelivery();
    while (delivery && !delivery.runId && (delivery.status === "queued" || delivery.status === "running")) {
      await delay(100, undefined, { signal });
      delivery = await readDelivery();
    }
    signal.throwIfAborted();
    if (stoppedByCommand(delivery)) {
      // The command landed before the turn had a run to watch: the cancellation answers it, nothing is left to speak.
      stopSpeech(session);
      session.stoppedTurns.delete(result.assistantMessageId);
      return;
    }
    if (!delivery?.runId || !delivery.firstEventId) throw new Error("Voice turn unavailable");
    session.textState.beginTurn();
    session.speechTurn = { runId: delivery.runId, assistantMessageId: result.assistantMessageId };
    let lastEventId = delivery.firstEventId;
    let failed = false;
    let watchFailure: unknown;
    const onFrame = (frame: VoiceRunFrame): boolean => {
      if (signal.aborted) return false;
      if (frame.type === "delta" && !("chunk" in frame.message)) {
        const delta = frame.message.delta;
        if (
          typeof delta === "object" &&
          delta !== null &&
          "kind" in delta &&
          delta.kind === "message_update" &&
          "type" in delta &&
          delta.type === "text_delta" &&
          "delta" in delta &&
          typeof delta.delta === "string"
        ) {
          try {
            session.textState.pushDelta(delta.delta);
            pump(session);
            return true;
          } catch (error) {
            session.sender.fail(error instanceof VoiceTextOverloadError ? "overloaded" : "unavailable");
            return false;
          }
        }
      }
      if (frame.type === "event" && frame.event.kind === "message") {
        const value = frame.event.payload;
        const text =
          typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
            ? value.text
            : undefined;
        try {
          session.textState.finishMessage(text);
          pump(session);
        } catch (error) {
          session.sender.fail(error instanceof VoiceTextOverloadError ? "overloaded" : "unavailable");
          return false;
        }
      }
      if (frame.type === "event") lastEventId = frame.event.id;
      return true;
    };
    let turnFailed = false;
    let turnFailure: unknown;
    let stopped = false;
    try {
      try {
        session.dispose = await sync.subscribeVoice({
          tenantId: session.identity.tenantId,
          userId: session.identity.userId,
          runId: delivery.runId,
          threadId: result.threadId,
          sempMessageId: result.assistantMessageId,
          afterEventId: delivery.firstEventId,
          signal,
          onFrame,
          onFailure(error, cause) {
            failed = true;
            watchFailure = error;
            if (cause === "overloaded") session.sender.fail("overloaded");
          },
        });
      } catch (watchError) {
        // The watch refuses a reply that was cancelled before it started: when this session's stop command did that,
        // the turn is over and nothing failed. Any other refusal is the failure it reports.
        if (signal.aborted || !session.stoppedTurns.has(result.assistantMessageId)) throw watchError;
        let cancelled: boolean;
        try {
          cancelled = stoppedByCommand(await readDelivery());
        } catch (readError) {
          // The refusal of the watch stays primary; the failed lookup is kept next to it.
          throw new AggregateError([watchError, readError], "Voice run watch and reply lookup failed", {
            // eslint-disable-next-line preserve-caught-error
            cause: watchError,
          });
        }
        if (!cancelled) throw watchError;
        stopped = true;
      }
      while (!stopped) {
        signal.throwIfAborted();
        if (failed) throw watchFailure;
        delivery = await readDelivery();
        signal.throwIfAborted();
        if (!delivery) throw new Error("Voice turn unavailable");
        if (delivery.status === "error") {
          // A turn this session stopped by voice ends as a cancellation: that answers the command, it is no failure.
          if (!stoppedByCommand(delivery)) throw new Error("Voice turn unavailable");
          stopped = true;
          break;
        }
        if (delivery.status === "done") {
          if (!delivery.lastEventId || delivery.runId === null) throw new Error("Voice turn unavailable");
          if (BigInt(lastEventId) >= BigInt(delivery.lastEventId)) break;
        }
        await delay(100, undefined, { signal });
      }
      if (stopped) stopSpeech(session);
      else session.textState.finishMessage(undefined);
      await session.speech;
    } catch (error) {
      turnFailed = true;
      turnFailure = error;
    }
    session.stoppedTurns.delete(result.assistantMessageId);
    session.speechTurn = undefined;
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    try {
      await session.dispose?.();
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
    session.dispose = undefined;
    if (turnFailed && cleanupFailed)
      throw new AggregateError([turnFailure, cleanupFailure], "Voice turn and watch cleanup failed", {
        cause: turnFailure,
      });
    if (turnFailed) throw turnFailure;
    if (cleanupFailed) throw cleanupFailure;
  }
  return {
    async onStart(identity, frame, sender) {
      if (frame.threadId) {
        const ruleKinds = await heartbeatRuleKinds();
        const thread = await runInTenant(identity.tenantId, () =>
          withTransaction(pool, (client) => getSempThread(client, frame.threadId!, ruleKinds)),
        );
        sender.signal.throwIfAborted();
        if (!thread) throw new Error("Voice thread unavailable");
      }
      let resolveStreamClosed!: () => void;
      const streamClosed = new Promise<void>((resolve) => {
        resolveStreamClosed = resolve;
      });
      const session: Session = {
        identity,
        sender,
        threadId: frame.threadId,
        stream: undefined,
        streamClosed,
        resolveStreamClosed,
        admission: Promise.resolve(),
        work: Promise.resolve(),
        admissionFailure: undefined,
        failures: [],
        queued: 0,
        speech: Promise.resolve(),
        speechController: undefined,
        textState: new VoiceTextState(),
        speechTurn: undefined,
        stoppedTurns: new Set(),
        speaking: false,
        dispose: undefined,
      };
      sessions.set(identity.userId, session);
      try {
        session.stream = await runInTenant(identity.tenantId, () =>
          openSttStream(
            gateway,
            { language: frame.language, signal: sender.signal },
            {
              onPartial(text) {
                if (sender.signal.aborted) return;
                try {
                  if (text.trim() && (session.speaking || session.speechController)) stopSpeech(session);
                  if (Buffer.byteLength(JSON.stringify({ type: "transcript", text, final: false })) > 4096) {
                    sender.fail("overloaded");
                    return;
                  }
                  sender.sendControl({ type: "transcript", text, final: false });
                } catch (error) {
                  fail(session, error);
                }
              },
              onFinal(text) {
                if (sender.signal.aborted) return;
                try {
                  if (text.trim() && (session.speaking || session.speechController)) stopSpeech(session);
                  if (Buffer.byteLength(JSON.stringify({ type: "transcript", text, final: true })) > 4096) {
                    sender.fail("overloaded");
                    return;
                  }
                  if (!sender.sendControl({ type: "transcript", text, final: true }) || !text.trim()) return;
                  if (isVoiceStopCommand(text)) {
                    stopCommand(session);
                    return;
                  }
                  if (session.queued >= MAX_QUEUED_TURNS) {
                    sender.fail("overloaded");
                    return;
                  }
                  session.queued++;
                  const admitted = session.admission
                    .then(() => {
                      if (session.admissionFailure) throw session.admissionFailure.error;
                      return admit(session, text);
                    })
                    .then(
                      (result) => ({ ok: true as const, result }),
                      (error: unknown) => {
                        if (!session.admissionFailure && !isSessionCancellation(error, sender.signal)) {
                          session.admissionFailure = { error };
                          session.failures.push(error);
                          fail(session, error);
                        }
                        return { ok: false as const };
                      },
                    );
                  session.admission = admitted.then(() => undefined);
                  session.work = session.work
                    .then(async () => {
                      const outcome = await admitted;
                      if (outcome.ok) await turn(session, outcome.result);
                    })
                    .catch((error: unknown) => {
                      if (!isSessionCancellation(error, sender.signal)) {
                        session.failures.push(error);
                        fail(session, error);
                      }
                    })
                    .finally(() => {
                      session.queued--;
                    });
                } catch (error) {
                  fail(session, error);
                }
              },
              onError(code) {
                sender.fail(
                  code === "budget_exceeded" ? "budgetExceeded" : code === "capacity" ? "overloaded" : "unavailable",
                );
              },
              onClose() {
                session.resolveStreamClosed();
                if (!sender.signal.aborted) sender.fail("unavailable");
              },
            },
          ),
        );
        sender.signal.throwIfAborted();
        sender.sendControl({ type: "ready" });
      } catch (error) {
        if (!session.stream) session.resolveStreamClosed();
        throw error;
      }
    },
    onAudio(identity, pcm) {
      return sessions.get(identity.userId)?.stream?.sendAudio(pcm) ?? false;
    },
    onControl(identity, frame) {
      if (frame.type === "end") sessions.get(identity.userId)?.stream?.end();
    },
    async onClose(identity) {
      const session = sessions.get(identity.userId);
      if (!session) return;
      const dispose = session.dispose;
      const disposing = Promise.resolve().then(() => dispose?.());
      const cleanupFailures: unknown[] = [];
      try {
        session.speechController?.abort();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        session.stream?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      const results = await Promise.allSettled([
        session.streamClosed,
        session.admission,
        session.work,
        session.speech,
        disposing,
      ]);
      sessions.delete(identity.userId);
      for (const result of results) if (result.status === "rejected") cleanupFailures.push(result.reason);
      if (cleanupFailures.length) {
        const failures = [...session.failures];
        for (const error of cleanupFailures) {
          if (!failures.some((prior) => Object.is(prior, error))) failures.push(error);
        }
        throw new AggregateError(failures, "Voice session cleanup failed", { cause: failures[0] });
      }
      if (session.failures.length) return { operationFailures: session.failures };
    },
  };
}
