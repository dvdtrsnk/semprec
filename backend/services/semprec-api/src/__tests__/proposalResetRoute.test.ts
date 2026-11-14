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
    userOverrides: z.record(z.string(), z.unknown()),
    userEditedKeys: z.array(z.string()),
    history: z.array(
      z.object({ author: z.string(), kind: z.string().optional(), keys: z.array(z.string()).optional() }),
    ),
  }),
});
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
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

/** The part of a card body that its row holds: the answer of a write and a later read differ in the envelope's `computed` fields only. */
const rowOf = (text: string): unknown => {
  const { id, updatedAt, properties } = z
    .object({ id: z.string(), updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(text));
  return { id, updatedAt, properties };
};

const readCard = async (id: string): Promise<string> => {
  const answer = await send(harness.headersA, "GET", `/api/items/${id}`);
  expect(answer.status, answer.text).toBe(200);
  return answer.text;
};

/** Types a manual title over the card's assistant title through the values route. */
async function editTitle(id: string, name: string): Promise<void> {
  const edited = await send(harness.headersA, "PATCH", `/api/proposals/${id}/values`, { set: { primary: { name } } });
  expect(edited.status, edited.text).toBe(200);
}

describe("POST /api/proposals/:id/reset-overrides over HTTP (issue #1912)", () => {
  beforeAll(() => harness.start());
  beforeEach(async () => {
    await harness.reset();
    // One tenant after the other: concurrent seeding of two tenants deadlocks on the shared partition catalog.
    for (const tenantId of [harness.tenantA, harness.tenantB]) {
      await runInTenant(tenantId, () => seedSystem(harness.runtime));
    }
  });
  afterAll(() => harness.stop());

  it("answers the card with the assistant's envelope, no manual values and a reset history entry", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await editTitle(id, "Poslat fakturu Alze");

    const reset = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`, {});

    expect(reset.status, reset.text).toBe(200);
    const card = cardBody.parse(JSON.parse(reset.text));
    expect(card.id).toBe(id);
    expect(card.properties.proposal.properties).toEqual({ name: "Send the invoice" });
    expect(card.properties.userOverrides).toEqual({});
    expect(card.properties.userEditedKeys).toEqual([]);
    expect(card.properties.history.at(-1)).toEqual({ author: "user", kind: "reset", keys: ["primary.name"] });
    expect(rowOf(await readCard(id))).toEqual(rowOf(reset.text));
  });

  it("answers a request without a body as an empty one", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await editTitle(id, "Poslat fakturu Alze");

    const reset = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`);

    expect(reset.status, reset.text).toBe(200);
    expect(cardBody.parse(JSON.parse(reset.text)).properties.userEditedKeys).toEqual([]);
  });

  it("answers the card unchanged and adds no history entry when nothing is edited", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const before = await readCard(id);

    const reset = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`, {});

    expect(reset.status, reset.text).toBe(200);
    expect(rowOf(reset.text)).toEqual(rowOf(before));
    expect(await readCard(id)).toBe(before);
  });

  it("answers 409 version_conflict with the current card in details.currentItem when ifVersion is stale, and writes nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    const stale = cardBody.pick({ updatedAt: true }).parse(JSON.parse(await readCard(id))).updatedAt;
    await editTitle(id, "First edit");
    const before = await readCard(id);

    const refused = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`, { ifVersion: stale });

    expect(refused.status, refused.text).toBe(409);
    const error = errorBody.parse(JSON.parse(refused.text)).error;
    expect(error.code).toBe("version_conflict");
    expect(z.object({ currentItem: z.object({ id: z.string() }) }).parse(error.details).currentItem.id).toBe(id);
    expect(await readCard(id)).toBe(before);
  });

  it("answers 400 for an ifVersion that is no timestamp, and writes nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await editTitle(id, "First edit");
    const before = await readCard(id);

    const refused = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`, {
      ifVersion: "yesterday",
    });

    expect(refused.status, refused.text).toBe(400);
    expect(errorBody.parse(JSON.parse(refused.text)).error.details).toEqual({ field: "ifVersion" });
    expect(await readCard(id)).toBe(before);
  });

  it("answers 400 validation_failed for a card that is confirmed, and writes nothing", async () => {
    const id = await createCard(harness.tenantA, "Send the invoice");
    await editTitle(id, "Poslat fakturu Alze");
    const confirmed = await send(harness.headersA, "POST", `/api/proposals/${id}/confirm`);
    expect(confirmed.status, confirmed.text).toBe(200);
    const before = await readCard(id);

    const late = await send(harness.headersA, "POST", `/api/proposals/${id}/reset-overrides`, {});

    expect(late.status, late.text).toBe(400);
    expect(errorBody.parse(JSON.parse(late.text)).error.code).toBe("validation_failed");
    expect(await readCard(id)).toBe(before);
  });

  it("answers another tenant's card as it answers a random id, and leaves the card as it was", async () => {
    const foreign = await createCard(harness.tenantA, "Send the invoice");
    await editTitle(foreign, "Poslat fakturu Alze");
    const before = await readCard(foreign);

    const onForeign = await send(harness.headersB, "POST", `/api/proposals/${foreign}/reset-overrides`, {});
    const onRandom = await send(harness.headersB, "POST", `/api/proposals/${randomUUID()}/reset-overrides`, {});

    expect(onForeign.status).toBe(404);
    expect(onForeign.status).toBe(onRandom.status);
    expect(errorBody.parse(JSON.parse(onForeign.text)).error.code).toBe(
      errorBody.parse(JSON.parse(onRandom.text)).error.code,
    );
    expect(await readCard(foreign)).toBe(before);
  });
});
