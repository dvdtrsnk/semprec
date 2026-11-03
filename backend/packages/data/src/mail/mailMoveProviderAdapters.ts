import type { ImapFlow } from "imapflow";
import { logger } from "./logger.js";

type GmailMoveCommand = "trash" | "untrash" | "add_inbox" | "remove_inbox";
type GraphMoveDestination = "archive" | "deleteditems" | "inbox" | "sentitems";
const gmailPreparers = new WeakMap<
  object,
  (id: string, step: GmailMoveCommand) => Promise<() => Promise<GmailMoveResult>>
>();
const graphPreparers = new WeakMap<
  object,
  (id: string, destination: GraphMoveDestination) => Promise<() => Promise<GraphMoveResult>>
>();
export function hasGmailMovePreparer(client: object): boolean {
  return gmailPreparers.has(client);
}
export function hasGraphMovePreparer(client: object): boolean {
  return graphPreparers.has(client);
}

export function registerGmailMovePreparer(
  client: object,
  prepare: (id: string, step: GmailMoveCommand) => Promise<() => Promise<GmailMoveResult>>,
): void {
  gmailPreparers.set(client, prepare);
}
export function registerGraphMovePreparer(
  client: object,
  prepare: (id: string, destination: GraphMoveDestination) => Promise<() => Promise<GraphMoveResult>>,
): void {
  graphPreparers.set(client, prepare);
}
export function prepareGmailMove(
  client: object,
  id: string,
  step: GmailMoveCommand,
): Promise<() => Promise<GmailMoveResult>> {
  const prepare = gmailPreparers.get(client);
  if (!prepare) throw new Error("Gmail move adapter is unavailable");
  return prepare(id, step);
}
export function prepareGraphMove(
  client: object,
  id: string,
  destination: GraphMoveDestination,
): Promise<() => Promise<GraphMoveResult>> {
  const prepare = graphPreparers.get(client);
  if (!prepare) throw new Error("Graph move adapter is unavailable");
  return prepare(id, destination);
}

/** Selects only an IMAP operation sequence that can expunge one specified UID. */
export function selectImapMoveProtocol(capabilities: ReadonlySet<string>): "move" | "copy" | "unsupportedCapability" {
  if (capabilities.has("MOVE")) return "move";
  if (capabilities.has("UIDPLUS")) return "copy";
  return "unsupportedCapability";
}

export type SafeImapMoveStepResult =
  | { kind: "acknowledged"; targetUid?: number; targetUidValidity?: string }
  | { kind: "unsupportedCapability" }
  | { kind: "uncertain" };

export type ImapMoveStepResult =
  | { kind: "acknowledged"; targetUid?: number; targetUidValidity?: string }
  | { kind: "unsupportedCapability" }
  | { kind: "uncertain"; observed: unknown };

/** Runs one owned, already claimed command on the selected source connection. */
export async function executeImapMoveStep(
  client: ImapFlow,
  step: "move" | "copy" | "mark_deleted" | "expunge",
  sourcePath: string,
  sourceUid: number,
  sourceUidValidity: string,
  targetPath: string,
): Promise<ImapMoveStepResult> {
  if (!Number.isSafeInteger(sourceUid) || sourceUid < 1 || sourceUid > 4_294_967_295) {
    throw new Error("Invalid IMAP source UID");
  }
  if (
    !client.mailbox ||
    client.mailbox.path !== sourcePath ||
    String(client.mailbox.uidValidity) !== sourceUidValidity
  ) {
    return { kind: "uncertain", observed: undefined };
  }
  const capabilities = new Set(client.capabilities.keys());
  if ((step === "move" && !capabilities.has("MOVE")) || (step !== "move" && !capabilities.has("UIDPLUS"))) {
    return { kind: "unsupportedCapability" };
  }
  if (step === "mark_deleted" || step === "expunge") {
    const result =
      step === "mark_deleted"
        ? await client.messageFlagsAdd(String(sourceUid), ["\\Deleted"], { uid: true })
        : await client.messageDelete(String(sourceUid), { uid: true });
    return result === true ? { kind: "acknowledged" } : { kind: "uncertain", observed: result };
  }
  const result =
    step === "move"
      ? await client.messageMove(String(sourceUid), targetPath, { uid: true })
      : await client.messageCopy(String(sourceUid), targetPath, { uid: true });
  if (
    !result ||
    result.path !== sourcePath ||
    result.destination !== targetPath ||
    result.uidMap?.size !== 1 ||
    result.uidMap.get(sourceUid) === undefined ||
    result.uidValidity === undefined
  ) {
    return { kind: "uncertain", observed: result };
  }
  const targetUid = result.uidMap.get(sourceUid);
  if (
    targetUid === undefined ||
    !Number.isSafeInteger(targetUid) ||
    targetUid < 1 ||
    targetUid > 4_294_967_295 ||
    result.uidValidity < 1n ||
    result.uidValidity > 4_294_967_295n
  ) {
    return { kind: "uncertain", observed: result };
  }
  return { kind: "acknowledged", targetUid, targetUidValidity: result.uidValidity.toString() };
}

const MOVE_RESPONSE_LIMIT = 16 * 1024;

/** Reads one bounded Mail move response and closes its reader before returning. */
async function readMoveResponse(response: Response): Promise<{ body: unknown; cleanupFailures: unknown[] }> {
  if (!response.body) throw new Error("Missing Mail move response");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let primary: { value: unknown } | undefined;
  let body: unknown;
  const secondary: unknown[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MOVE_RESPONSE_LIMIT) throw new Error("Mail move response exceeded its limit");
      chunks.push(part.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    primary = { value: error };
  }
  try {
    await reader.cancel();
  } catch (error) {
    secondary.push(error);
  }
  try {
    reader.releaseLock();
  } catch (error) {
    secondary.push(error);
  }
  if (primary && secondary.length > 0)
    throw new AggregateError([primary.value, ...secondary], "Mail move response and cleanup failed");
  if (primary) throw primary.value;
  return { body, cleanupFailures: secondary };
}

export type GraphMoveResult =
  | { kind: "found"; id: string; parentFolderId: string }
  | { kind: "moved"; id: string }
  | { kind: "missing" }
  | { kind: "uncertain" };

/** Executes a single Graph observation or move; the access token is acquired by the caller. */
export async function graphMoveRequest(
  fetchImpl: typeof fetch,
  token: string,
  messageId: string,
  destination?: "archive" | "deleteditems" | "inbox" | "sentitems",
): Promise<GraphMoveResult> {
  if (!messageId || messageId.length > 1024) throw new Error("Invalid Graph message identity");
  const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`;
  let response: Response | undefined;
  const observed: unknown[] = [];
  let result: GraphMoveResult = { kind: "uncertain" };
  try {
    response = await fetchImpl(destination ? `${url}/move` : `${url}?$select=id,parentFolderId`, {
      method: destination ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(destination ? { "Content-Type": "application/json" } : {}) },
      ...(destination ? { body: JSON.stringify({ destinationId: destination }) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!destination && response.status === 404) {
      result = { kind: "missing" };
    } else if (response.ok) {
      const { body, cleanupFailures } = await readMoveResponse(response);
      observed.push(...cleanupFailures);
      if (
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        typeof body.id === "string" &&
        body.id.length > 0 &&
        body.id.length <= 1024
      ) {
        if (destination) result = { kind: "moved", id: body.id };
        else if (
          body.id === messageId &&
          "parentFolderId" in body &&
          typeof body.parentFolderId === "string" &&
          body.parentFolderId.length > 0 &&
          body.parentFolderId.length <= 1024
        )
          result = { kind: "found", id: body.id, parentFolderId: body.parentFolderId };
      }
    }
  } catch (error) {
    observed.push(error);
  }
  if (response?.body && !response.body.locked) {
    try {
      await response.body.cancel();
    } catch (error) {
      observed.push(error);
    }
  }
  if (observed.length > 0) {
    try {
      logger.warn({ stage: "graph_move", category: "failure" }, "Mail move provider operation failed");
    } catch (error) {
      observed.push(error);
    }
  }
  // Keep all values through response settlement; provider details never leave this boundary.
  void observed;
  return result;
}

export type GmailMoveResult =
  | { kind: "found"; inTrash: boolean; inInbox: boolean; inSent: boolean }
  | { kind: "acknowledged"; inTrash: boolean; inInbox: boolean; inSent: boolean }
  | { kind: "missing" }
  | { kind: "uncertain" };

/** Executes one bounded Gmail observation or previously claimed mutation. */
export async function gmailMoveRequest(
  fetchImpl: typeof fetch,
  token: string,
  messageId: string,
  step?: "trash" | "untrash" | "add_inbox" | "remove_inbox",
): Promise<GmailMoveResult> {
  if (!messageId || messageId.length > 1024) throw new Error("Invalid Gmail message identity");
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`;
  const suffix = step === "add_inbox" || step === "remove_inbox" ? "modify" : step;
  let response: Response | undefined;
  const observed: unknown[] = [];
  let result: GmailMoveResult = { kind: "uncertain" };
  try {
    response = await fetchImpl(step ? `${base}/${suffix}` : `${base}?format=minimal`, {
      method: step ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(step ? { "Content-Type": "application/json" } : {}) },
      ...(step === "add_inbox" ? { body: JSON.stringify({ addLabelIds: ["INBOX"], removeLabelIds: [] }) } : {}),
      ...(step === "remove_inbox" ? { body: JSON.stringify({ addLabelIds: [], removeLabelIds: ["INBOX"] }) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!step && response.status === 404) {
      result = { kind: "missing" };
    } else if (response.ok) {
      const { body, cleanupFailures } = await readMoveResponse(response);
      observed.push(...cleanupFailures);
      if (
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        body.id === messageId &&
        "labelIds" in body &&
        Array.isArray(body.labelIds) &&
        body.labelIds.length <= 256 &&
        body.labelIds.every((value: unknown) => typeof value === "string" && value.length <= 1024)
      ) {
        const labels: unknown[] = body.labelIds;
        const fields = {
          inTrash: labels.includes("TRASH"),
          inInbox: labels.includes("INBOX"),
          inSent: labels.includes("SENT"),
        };
        result = step ? { kind: "acknowledged", ...fields } : { kind: "found", ...fields };
      }
    }
  } catch (error) {
    observed.push(error);
  }
  if (response?.body && !response.body.locked) {
    try {
      await response.body.cancel();
    } catch (error) {
      observed.push(error);
    }
  }
  if (observed.length > 0) {
    try {
      logger.warn({ stage: "gmail_move", category: "failure" }, "Mail move provider operation failed");
    } catch (error) {
      observed.push(error);
    }
  }
  void observed;
  return result;
}
