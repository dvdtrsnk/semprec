import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createItemWithClient, getDatabaseByModuleId, seedSystem, withTransaction } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const cardBody = z.object({
  id: z.string(),
  updatedAt: z.string(),
  properties: z.object({
    status: z.string(),
    proposal: z.object({ properties: z.record(z.string(), z.unknown()) }),
    userEditedKeys: z.array(z.string()),
    history: z.array(
      z.object({ author: z.string(), kind: z.string().optional(), keys: z.array(z.string()).optional() }),
    ),
  }),
});
const versionBody = z.object({ updatedAt: z.string() });
const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

/** A `proposed` Processing proposals card of `tenantId` whose assistant envelope creates a task named `name`. */
async function createCard(tenantId: string, name: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(harness.runtime, async (client) => {
      const cards = await getDatabaseByModuleId(client, "processingProposals");
      const tasks = await getDatabaseByModuleId(client, "tasks");
      if (!cards || !tasks) throw new Error("The Inbox pipeline databases were not seeded");
      const envelope = { entityKind: "database", target: tasks.id, properties: { name } };
      const card = await createItemWithClient(
        client,
        {
          databaseId: cards.id,
          properties: { kind: "inbox", status: "proposed", proposal: envelope, aiProposal: envelope },
        },
        { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal"] },
      );
      return card.id;
    }),
  );
}

async function send(
  headers: { Authorization: string },
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

const readCard = async (id: string): Promise<string> => {
  const answer = await send(harness.headersA, "GET", `/api/items/${id}`);
  expect(answer.status, answer.text).toBe(200);
  return answer.text;
};

describe("PATCH /api/proposals/:id/values over HTTP (issue #1892)", () => {
  beforeAll(() => harness.start());
  beforeEach(async () => {
    await harness.reset();
    // One tenant after the other: concurrent seeding of two tenants deadlocks on the shared partition catalog.
    for (const tenantId of [harness.tenantA, harness.tenantB]) {
      await runInTenant(tenantId, () => seedSystem(harness.runtime));
    }
  });
  afterAll(() => harness.stop());

  it("answers the edited card, marks the edited key, and drops it again when the value is set back", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");

    const edited = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "Poslat fakturu Alze" } },
    });

    expect(edited.status, edited.text).toBe(200);
    const card = cardBody.parse(JSON.parse(edited.text));
    expect(card.id).toBe(id);
    expect(card.properties.proposal.properties).toEqual({ name: "Poslat fakturu Alze" });
    expect(card.properties.userEditedKeys).toEqual(["primary.name"]);
    expect(card.properties.history.at(-1)).toEqual({ author: "user", kind: "userEdit", keys: ["primary.name"] });

    const reverted = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "Send the invoice" } },
    });

    expect(reverted.status, reverted.text).toBe(200);
    expect(cardBody.parse(JSON.parse(reverted.text)).properties.userEditedKeys).toEqual([]);
  });

  it("answers a top-level `warnings` list, empty for a complete card, and then refuses to confirm the card it saved incomplete", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const complete = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "Poslat fakturu Alze" } },
    });
    expect(complete.status, complete.text).toBe(200);
    expect(z.object({ warnings: z.array(z.unknown()) }).parse(JSON.parse(complete.text)).warnings).toEqual([]);

    const cleared = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "" } },
    });

    expect(cleared.status, cleared.text).toBe(200);
    const body: unknown = JSON.parse(cleared.text);
    expect(cardBody.parse(body).properties.proposal.properties).toEqual({ name: "" });
    expect(z.object({ warnings: z.array(z.unknown()) }).parse(body).warnings).toEqual([
      { field: "name", code: "required" },
    ]);

    const before = await readCard(id);
    const confirmed = await send(harness.headersA, "POST", `/api/proposals/${id}/confirm`);

    expect(confirmed.status, confirmed.text).toBe(400);
    const error = errorBody.parse(JSON.parse(confirmed.text)).error;
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual({ field: "name" });
    expect(await readCard(id)).toBe(before);
  });

  it("replaces a relation list over HTTP, counts it, and answers 400 for a primary step switched off or a target that does not exist", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const projectId = await runInTenant(harness.tenantA, () =>
      withTransaction(harness.runtime, async (client) => {
        const projects = await getDatabaseByModuleId(client, "projects");
        if (!projects) throw new Error("The Projects database was not seeded");
        return (await createItemWithClient(client, { databaseId: projects.id, properties: { name: "Invoices" } })).id;
      }),
    );

    const edited = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      relations: { primary: { project: [projectId] } },
    });

    expect(edited.status, edited.text).toBe(200);
    const body: unknown = JSON.parse(edited.text);
    const relations = z
      .object({
        properties: z.object({ proposal: z.object({ relations: z.record(z.string(), z.array(z.string())) }) }),
      })
      .parse(body).properties.proposal.relations;
    expect(relations).toEqual({ project: [projectId] });
    expect(cardBody.parse(body).properties.userEditedKeys).toEqual(["primary.relations.project"]);
    const before = await readCard(id);

    const off = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      steps: { primary: { enabled: false } },
    });
    const missing = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      relations: { primary: { project: [randomUUID()] } },
    });

    expect(off.status, off.text).toBe(400);
    expect(errorBody.parse(JSON.parse(off.text)).error.details).toEqual({ ref: "primary", field: "enabled" });
    expect(missing.status, missing.text).toBe(400);
    expect(errorBody.parse(JSON.parse(missing.text)).error.details).toEqual({
      field: "project",
      code: "targetNotFound",
    });
    expect(await readCard(id)).toBe(before);
  });

  it("answers 409 version_conflict with the current card in details.currentItem when ifVersion is stale, and writes nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const stale = versionBody.parse(JSON.parse(await readCard(id))).updatedAt;
    const first = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "First edit" } },
    });
    expect(first.status, first.text).toBe(200);
    const before = await readCard(id);

    const refused = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "Second edit" } },
      ifVersion: stale,
    });

    expect(refused.status, refused.text).toBe(409);
    const error = errorBody.parse(JSON.parse(refused.text)).error;
    expect(error.code).toBe("version_conflict");
    expect(z.object({ currentItem: z.object({ id: z.string() }) }).parse(error.details).currentItem.id).toBe(id);
    expect(await readCard(id)).toBe(before);
  });

  it("answers 400 for a card that is confirmed and 400 for a body without set", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const noSet = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {});
    expect(noSet.status, noSet.text).toBe(400);
    expect(errorBody.parse(JSON.parse(noSet.text)).error.details).toMatchObject({ field: "set" });

    const confirmed = await send(harness.headersA, "POST", `/api/proposals/${id}/confirm`);
    expect(confirmed.status, confirmed.text).toBe(200);
    const before = await readCard(id);
    const late = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, {
      set: { primary: { name: "Late" } },
    });

    expect(late.status, late.text).toBe(400);
    expect(errorBody.parse(JSON.parse(late.text)).error.code).toBe("validation_failed");
    expect(await readCard(id)).toBe(before);
  });

  it.each(["proposal", "status", "history"])(
    "keeps answering 403 to a generic PATCH /api/items/:id of the system-owned '%s' and writes nothing",
    async (key) => {
      const id = await createCard(harness.tenantA, "Send the invoice");
      const before = await readCard(id);
      const updatedAt = versionBody.parse(JSON.parse(before)).updatedAt;

      const refused = await send(harness.headersA, "PATCH", `/api/items/${id}`, {
        properties: { [key]: key === "status" ? "rejected" : key === "history" ? [] : { entityKind: "database" } },
        ifVersion: updatedAt,
      });

      expect(refused.status, refused.text).toBe(403);
      expect(await readCard(id)).toBe(before);
    },
  );

  it("answers another tenant's card as it answers a random id, and leaves the card as it was", async () => {
    const foreign = await createCard(harness.tenantA, "Send the invoice");
    const before = await readCard(foreign);
    const body = { set: { primary: { name: "Foreign edit" } } };

    const onForeign = await send(harness.headersB, "PATCH", `/api/proposals/${foreign}/values`, body);
    const onRandom = await send(harness.headersB, "PATCH", `/api/proposals/${randomUUID()}/values`, body);

    expect(onForeign.status).toBe(404);
    expect(onForeign.status).toBe(onRandom.status);
    expect(errorBody.parse(JSON.parse(onForeign.text)).error.code).toBe(
      errorBody.parse(JSON.parse(onRandom.text)).error.code,
    );
    expect(await readCard(foreign)).toBe(before);
  });
});

describe("PATCH /api/proposals/:id/values with an Idempotency-Key over HTTP (issue gh-1894)", () => {
  beforeAll(() => harness.start());
  beforeEach(async () => {
    await harness.reset();
    // One tenant after the other: concurrent seeding of two tenants deadlocks on the shared partition catalog.
    for (const tenantId of [harness.tenantA, harness.tenantB]) {
      await runInTenant(tenantId, () => seedSystem(harness.runtime));
    }
  });
  afterAll(() => harness.stop());

  const patchValues = (
    headers: { Authorization: string },
    id: string,
    name: string,
    key?: string,
    extra: Record<string, unknown> = {},
  ) =>
    send(
      headers,
      "PATCH",
      `/api/proposals/${id}/values`,
      { set: { primary: { name } }, ...extra },
      key === undefined ? {} : { "Idempotency-Key": key },
    );

  /** The edits the card's history records, and its current name. */
  async function cardState(id: string): Promise<{ edits: number; name: unknown }> {
    const card = cardBody.parse(JSON.parse(await readCard(id)));
    return {
      edits: card.properties.history.filter((entry) => entry.kind === "userEdit").length,
      name: card.properties.proposal.properties.name,
    };
  }

  async function storedRows(tenantId: string): Promise<{ user_id: string; key: string; route: string }[]> {
    const { rows } = await runInTenant(tenantId, () =>
      harness.runtime.query<{ user_id: string; key: string; route: string }>(
        "SELECT user_id, key, route FROM idempotent_responses ORDER BY created_at",
      ),
    );
    return rows;
  }

  it("answers a repeat of the key and body with the same response and keeps one history entry", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");

    const first = await patchValues(harness.headersA, id, "Poslat fakturu Alze", "key-1");
    const second = await patchValues(harness.headersA, id, "Poslat fakturu Alze", "key-1");

    expect(first.status, first.text).toBe(200);
    expect(second.status).toBe(first.status);
    expect(second.text).toBe(first.text);
    expect(await cardState(id)).toEqual({ edits: 1, name: "Poslat fakturu Alze" });
    expect(await storedRows(harness.tenantA)).toMatchObject([
      { key: "key-1", route: "PATCH /api/proposals/:id/values" },
    ]);
  });

  it("fails the same key with another body as validation_failed and applies nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await patchValues(harness.headersA, id, "First edit", "key-1");
    const before = await readCard(id);

    const refused = await patchValues(harness.headersA, id, "Second edit", "key-1");

    expect(refused.status, refused.text).toBe(400);
    const error = errorBody.parse(JSON.parse(refused.text)).error;
    expect(error.code).toBe("validation_failed");
    expect(error.details).toMatchObject({ field: "Idempotency-Key" });
    expect(await readCard(id)).toBe(before);
    expect(await cardState(id)).toEqual({ edits: 1, name: "First edit" });
  });

  it("fails the same key and body on another card as validation_failed and edits neither card", async () => {
    const first = await createCard(harness.tenantA, "Send the invoice");
    const other = await createCard(harness.tenantA, "Water the plants");
    await patchValues(harness.headersA, first, "Edited", "key-1");
    const before = await readCard(other);

    const refused = await patchValues(harness.headersA, other, "Edited", "key-1");

    expect(refused.status, refused.text).toBe(400);
    expect(errorBody.parse(JSON.parse(refused.text)).error.code).toBe("validation_failed");
    expect(await readCard(other)).toBe(before);
  });

  it("runs the action again when the stored row is older than 24 hours", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await patchValues(harness.headersA, id, "Old edit", "key-1");
    // Fixture SQL: the only way to age a stored row past its 24 hours.
    await harness.admin.query("UPDATE idempotent_responses SET expires_at = now() - interval '1 second'");

    const answered = await patchValues(harness.headersA, id, "New edit", "key-1");

    expect(answered.status, answered.text).toBe(200);
    expect(await cardState(id)).toEqual({ edits: 2, name: "New edit" });
    expect(await storedRows(harness.tenantA)).toHaveLength(1);
  });

  it("shows another tenant no row and gives it a fresh execution for the same key", async () => {
    const cardA = await createCard(harness.tenantA, "Send the invoice");
    const cardB = await createCard(harness.tenantB, "Send the invoice");
    await patchValues(harness.headersA, cardA, "Edited by A", "key-1");

    const answeredForB = await patchValues(harness.headersB, cardB, "Edited by B", "key-1");

    expect(answeredForB.status, answeredForB.text).toBe(200);
    expect(cardBody.parse(JSON.parse(answeredForB.text)).id).toBe(cardB);
    expect(await storedRows(harness.tenantA)).toHaveLength(1);
    expect(await storedRows(harness.tenantB)).toHaveLength(1);
    // Tenant B's scope reads its own row only: tenant A's user id is not among its rows.
    const [rowA] = await storedRows(harness.tenantA);
    expect((await storedRows(harness.tenantB)).map((row) => row.user_id)).not.toContain(rowA?.user_id);
    const { rows: foreign } = await runInTenant(harness.tenantB, () =>
      harness.runtime.query("SELECT 1 FROM idempotent_responses WHERE user_id = $1", [rowA?.user_id]),
    );
    expect(foreign).toEqual([]);
  });

  it("stores nothing for a request without the header", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");

    const answered = await patchValues(harness.headersA, id, "No key");

    expect(answered.status, answered.text).toBe(200);
    expect(await storedRows(harness.tenantA)).toEqual([]);
  });

  it("stores nothing for a refused update, so the key still runs the action afterwards", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const stale = versionBody.parse(JSON.parse(await readCard(id))).updatedAt;
    await patchValues(harness.headersA, id, "First edit");

    const refused = await patchValues(harness.headersA, id, "Second edit", "key-1", { ifVersion: stale });

    expect(refused.status, refused.text).toBe(409);
    expect(await storedRows(harness.tenantA)).toEqual([]);
    const retried = await patchValues(harness.headersA, id, "Second edit", "key-1");
    expect(retried.status, retried.text).toBe(200);
    expect(await cardState(id)).toEqual({ edits: 2, name: "Second edit" });
  });

  it("refuses an Idempotency-Key of more than 255 characters with validation_failed and applies nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const before = await readCard(id);

    const refused = await patchValues(harness.headersA, id, "Edited", "k".repeat(256));

    expect(refused.status, refused.text).toBe(400);
    expect(errorBody.parse(JSON.parse(refused.text)).error.details).toMatchObject({ field: "Idempotency-Key" });
    expect(await readCard(id)).toBe(before);
    expect(await storedRows(harness.tenantA)).toEqual([]);
  });
});
