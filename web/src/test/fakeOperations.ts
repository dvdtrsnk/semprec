import { OperationError, type FilterNode, type GenericOperations, type Item, type ListItemsRequest, type View } from "../api/genericOperations.js";

/**
 * An in-memory stand-in for the backend's generic operations, evaluating the same filter
 * trees the real ones compile to SQL — including `relation_contains` over a relation edge
 * list — and applying writes to the same item/edge lists it reads from. Tests therefore
 * exercise the actual request the client makes, rather than a hand-stubbed answer per call,
 * and a triage action's effect is observable in the next read exactly as it would be
 * against the real backend.
 */
export interface FakeItem {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

export interface FakeRelationEdge {
  property: string;
  itemId: string;
  targetItemId: string;
}

/** What the fake's mail operations need to know about the module they stand in for. */
export interface FakeMailModule {
  emailsDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationKey: string;
  /** Structured envelopes, per message item id; a message missing here has none, as a legacy one does. */
  envelopes: Record<string, unknown>;
  /** When set, `email.send` is rejected with this message — the backend refusing a send. */
  rejectSend?: string | null;
  /** Every accepted send, in order, exactly as the client submitted it. */
  sent: { draftItemId: string; payload: Record<string, unknown> }[];
  drafts: string[];
}

export interface FakeBackend {
  items: FakeItem[];
  relations: FakeRelationEdge[];
  views: View[];
  mail?: FakeMailModule;
}

function toItem(item: FakeItem): Item {
  return { id: item.id, databaseId: item.databaseId, properties: item.properties, computed: {}, updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null };
}

function matches(backend: FakeBackend, item: FakeItem, filter: FilterNode | undefined): boolean {
  if (!filter) return true;
  switch (filter.type) {
    case "and":
      return filter.nodes.every((node) => matches(backend, item, node));
    case "or":
      return filter.nodes.some((node) => matches(backend, item, node));
    case "not":
      return !matches(backend, item, filter.node);
    case "relation_contains":
    case "relation_not_contains": {
      const linked = backend.relations.some(
        (edge) => edge.property === filter.property && edge.itemId === item.id && edge.targetItemId === filter.value,
      );
      return filter.type === "relation_contains" ? linked : !linked;
    }
    case "equals":
      return item.properties[filter.property] === filter.value;
    case "not_equals":
      return item.properties[filter.property] !== filter.value;
    case "is_empty":
      return item.properties[filter.property] === undefined || item.properties[filter.property] === "";
    case "is_not_empty":
      return item.properties[filter.property] !== undefined && item.properties[filter.property] !== "";
  }
}

function select(backend: FakeBackend, databaseId: string, request: ListItemsRequest = {}): FakeItem[] {
  const rows = backend.items.filter((item) => item.databaseId === databaseId && matches(backend, item, request.filter));
  const [sort] = request.sort ?? [];
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const left = String(a.properties[sort.property] ?? "");
    const right = String(b.properties[sort.property] ?? "");
    return sort.direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
  });
}

export function createFakeOperations(backend: FakeBackend): GenericOperations {
  return {
    async listItems(databaseId, request) {
      const rows = select(backend, databaseId, request);
      return { items: rows.map(toItem), nextCursor: null };
    },
    async countItems(databaseId, request) {
      return select(backend, databaseId, request).length;
    },
    async getItem(databaseId, itemId) {
      const row = backend.items.find((item) => item.databaseId === databaseId && item.id === itemId);
      return row ? toItem(row) : null;
    },
    async getView(viewId) {
      const view = backend.views.find((candidate) => candidate.id === viewId);
      if (!view) throw new Error(`View ${viewId} not found`);
      return view;
    },
    async updateItem(databaseId, itemId, propertiesPatch) {
      const row = backend.items.find((item) => item.databaseId === databaseId && item.id === itemId);
      if (!row) throw new OperationError("unavailable", `Item ${itemId} not found`, 404);
      row.properties = { ...row.properties, ...propertiesPatch };
      return toItem(row);
    },
    // Edges are keyed by the relation property key alone, exactly as the fake's filter
    // evaluation reads them; the database id only names where the item lives.
    async linkItem(_databaseId, itemId, relationKey, targetItemId) {
      const exists = backend.relations.some((edge) => edge.property === relationKey && edge.itemId === itemId && edge.targetItemId === targetItemId);
      if (!exists) backend.relations.push({ property: relationKey, itemId, targetItemId });
    },
    async unlinkItem(_databaseId, itemId, relationKey, targetItemId) {
      backend.relations = backend.relations.filter(
        (edge) => !(edge.property === relationKey && edge.itemId === itemId && edge.targetItemId === targetItemId),
      );
    },

    async callOperation(operationId, input) {
      return runMailOperation(backend, operationId, input);
    },
  };
}

/** The mailbox item a folder belongs to, through the Folders-to-Mailboxes relation. */
function mailboxOfFolder(backend: FakeBackend, folderId: string): string | null {
  return backend.relations.find((edge) => edge.property === "mailbox" && edge.itemId === folderId)?.targetItemId ?? null;
}

function folderWithPurpose(backend: FakeBackend, mail: FakeMailModule, mailboxItemId: string, purpose: string): string | null {
  const folder = backend.items.find(
    (item) => item.databaseId === mail.foldersDatabaseId && item.properties.specialPurpose === purpose && mailboxOfFolder(backend, item.id) === mailboxItemId,
  );
  return folder?.id ?? null;
}

/**
 * The mail module's named operations, standing in for `email.message.envelope`,
 * `email.draft.create` and `email.send`. They behave the way the real ones do where the client
 * can tell the difference: a draft becomes a real Emails item linked into Drafts, a send moves
 * it to Sent, an unregistered From address is refused, and a message with no envelope row
 * simply has none — which is what makes the client's fallback to display text observable.
 */
async function runMailOperation(backend: FakeBackend, operationId: string, input: Record<string, unknown>): Promise<unknown> {
  const mail = backend.mail;
  if (!mail) throw new OperationError("unavailable", `Operation ${operationId} is not available`, 501);

  if (operationId === "email.message.envelope") {
    const envelope = mail.envelopes[String(input.itemId)];
    if (!envelope) throw new OperationError("unavailable", `No envelope for ${String(input.itemId)}`, 404);
    return envelope;
  }

  if (operationId === "email.draft.create") {
    const mailboxItemId = String(input.mailboxItemId);
    const draftsFolderId = folderWithPurpose(backend, mail, mailboxItemId, "drafts");
    if (!draftsFolderId) throw new OperationError("retryable", `Mailbox ${mailboxItemId} has no Drafts folder`, 400);
    const itemId = `draft-${mail.drafts.length + 1}`;
    backend.items.push({
      id: itemId,
      databaseId: mail.emailsDatabaseId,
      properties: { name: String(input.subject ?? ""), sender: "", recipients: "", body: String(input.bodyText ?? "") },
    });
    backend.relations.push({ property: mail.folderRelationKey, itemId, targetItemId: draftsFolderId });
    mail.drafts.push(itemId);
    return { itemId };
  }

  if (operationId === "email.send") {
    if (mail.rejectSend) throw new OperationError("retryable", mail.rejectSend, 500);
    const mailboxItemId = String(input.mailboxItemId);
    const draftItemId = String(input.draftItemId);
    const from = input.from as { address?: string } | undefined;
    const mailbox = backend.items.find((item) => item.id === mailboxItemId);
    const registered = String(mailbox?.properties.addresses ?? "")
      .split(/[\n,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (!registered.includes((from?.address ?? "").trim().toLowerCase())) {
      throw new OperationError("unavailable", `From address ${from?.address ?? ""} is not registered for mailbox ${mailboxItemId}`, 403);
    }
    const sentFolderId = folderWithPurpose(backend, mail, mailboxItemId, "sent");
    if (!sentFolderId) throw new OperationError("retryable", `Mailbox ${mailboxItemId} has no Sent folder`, 400);
    const draftsFolderId = folderWithPurpose(backend, mail, mailboxItemId, "drafts");
    backend.relations = backend.relations.filter(
      (edge) => !(edge.property === mail.folderRelationKey && edge.itemId === draftItemId && edge.targetItemId === draftsFolderId),
    );
    backend.relations.push({ property: mail.folderRelationKey, itemId: draftItemId, targetItemId: sentFolderId });
    mail.sent.push({ draftItemId, payload: input });
    return { itemId: draftItemId, messageId: `<sent-${mail.sent.length}@example.com>` };
  }

  throw new OperationError("unavailable", `Unknown operation ${operationId}`, 404);
}
