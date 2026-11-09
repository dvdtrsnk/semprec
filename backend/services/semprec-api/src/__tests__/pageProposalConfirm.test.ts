import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createInboxItemWithClient } from "@semprec/data/testSupport";
import {
  createItemWithClient,
  createSemprecTickAction,
  getDatabaseByModuleId,
  mutateYDoc,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const idsBody = z.object({ blockIds: z.array(z.string()) }).strict();
const errorBody = z.object({ error: z.object({ code: z.string() }) });

interface Databases {
  inboxId: string;
  typesId: string;
  proposalsId: string;
}

async function databases(): Promise<Databases> {
  return runInTenant(harness.tenantA, () =>
    withTransaction(harness.runtime, async (client) => {
      const ids = await Promise.all(
        ["inbox", "inboxItemTypes", "processingProposals"].map((moduleId) => getDatabaseByModuleId(client, moduleId)),
      );
      const [inbox, types, proposals] = ids;
      if (!inbox || !types || !proposals) throw new Error("The Inbox databases were not seeded");
      return { inboxId: inbox.id, typesId: types.id, proposalsId: proposals.id };
    }),
  );
}

/**
 * A page-content card for `target` through the production path: an active `pageContent` Inbox type, an Inbox item of
 * that type and one tick whose computation answers the v2 envelope. The shared owner fixture of the data package
 * (`createMarkdownPageContentProposal`) is not part of that package's exports, so this test builds the same card with
 * the exported pieces.
 */
async function createCard(ids: Databases, target: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(harness.tenantA, async () => {
    const type = await withTransaction(harness.runtime, (client) =>
      createItemWithClient(client, {
        databaseId: ids.typesId,
        properties: { name: "Page note", emoji: "📝", status: "active", processingMethod: "pageContent" },
      }),
    );
    const item = await withTransaction(harness.runtime, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: ids.inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Add to the page",
        type: type.id,
      }),
    );
    await createSemprecTickAction(harness.runtime, async () => ({ target, properties }))(
      {
        inboxDatabaseId: ids.inboxId,
        inboxItemTypesDatabaseId: ids.typesId,
        processingProposalsDatabaseId: ids.proposalsId,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const { rows } = await harness.runtime.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ids.proposalsId],
    );
    const card = rows[0];
    if (!card) throw new Error("The tick stored no proposal card");
    return card.id;
  });
}

async function confirm(cardId: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${harness.baseUrl}/api/proposals/${cardId}/confirm`, {
    method: "POST",
    headers: harness.headersA,
  });
  return { status: response.status, text: await response.text() };
}

async function insert(host: string, markdown: string): Promise<string[]> {
  const response = await fetch(`${harness.baseUrl}/api/items/${host}/page/insert`, {
    method: "POST",
    headers: { ...harness.headersA, "Content-Type": "application/json" },
    body: JSON.stringify({ placement: "end", markdown }),
  });
  expect(response.status).toBe(200);
  return idsBody.parse(await response.json()).blockIds;
}

async function pageTexts(host: string): Promise<string[]> {
  const response = await fetch(`${harness.baseUrl}/api/items/${host}/page`, { headers: harness.headersA });
  const body = z.object({ blocks: z.array(z.object({ text: z.string() })) }).parse(await response.json());
  return body.blocks.map((block) => block.text);
}

async function cardStatus(cardId: string): Promise<string | undefined> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ status: string }>(`SELECT properties->>'status' AS status FROM items WHERE id = $1`, [
      cardId,
    ]),
  );
  return rows[0]?.status;
}

/** The stored properties of a card, shown when a precondition about it fails. */
async function cardProperties(cardId: string): Promise<string> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ properties: unknown }>(`SELECT properties FROM items WHERE id = $1`, [cardId]),
  );
  return JSON.stringify(rows[0]?.properties);
}

async function updateCount(host: string): Promise<number> {
  const { rows } = await runInTenant(harness.tenantA, () =>
    harness.runtime.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1`,
      [host],
    ),
  );
  return rows[0]?.n ?? 0;
}

describe("POST /api/proposals/:id/confirm for page content (issue #1681)", () => {
  beforeAll(() => harness.start());
  beforeEach(async () => {
    await harness.reset();
    await runInTenant(harness.tenantA, () => seedSystem(harness.runtime));
  });
  afterAll(() => harness.stop());

  it("answers 409 when the chosen heading was removed, keeps the card proposed and writes nothing; then confirms once it exists", async () => {
    const ids = await databases();
    const host = await harness.createHost(harness.tenantA);
    const [headingId] = await insert(host, "## Tiles\n\nTile one");
    if (!headingId) throw new Error("Missing the heading id");
    const card = await createCard(ids, host, {
      markdown: "- first\n- second",
      placement: { afterHeading: headingId },
    });
    // Remove the heading the card names, as a client editing the page meanwhile would.
    const docId = await harness.docIdOf(harness.tenantA, host);
    await runInTenant(harness.tenantA, () =>
      mutateYDoc(harness.runtime, docId, "user", (doc) => {
        doc.getMap<Y.Map<unknown>>("blocks").delete(headingId);
        const order = doc.getArray<string>("order");
        order.delete(order.toArray().indexOf(headingId), 1);
      }),
    );
    expect(await cardStatus(card), await cardProperties(card)).toBe("proposed");
    const before = { texts: await pageTexts(host), updates: await updateCount(host) };

    const refused = await confirm(card);

    expect(refused.status, refused.text).toBe(409);
    expect(errorBody.parse(JSON.parse(refused.text)).error.code).toBe("version_conflict");
    expect(await cardStatus(card)).toBe("proposed");
    expect({ texts: await pageTexts(host), updates: await updateCount(host) }).toEqual(before);
  });

  it("confirms at the end of the section over HTTP and adds nothing when the same card is confirmed again", async () => {
    const ids = await databases();
    const host = await harness.createHost(harness.tenantA);
    const [headingId] = await insert(host, "## Tiles\n\nTile one\n\n## Other\n\nElsewhere");
    if (!headingId) throw new Error("Missing the heading id");
    const card = await createCard(ids, host, {
      markdown: "- first\n- second",
      placement: { afterHeading: headingId },
    });

    expect(await cardStatus(card), await cardProperties(card)).toBe("proposed");
    const first = await confirm(card);
    expect(first.status, first.text).toBe(200);
    const confirmedTexts = await pageTexts(host);
    expect(confirmedTexts).toEqual(["Tiles", "Tile one", "first", "second", "Other", "Elsewhere"]);
    const updates = await updateCount(host);

    const second = await confirm(card);

    expect(second.status, second.text).toBe(200);
    expect(await cardStatus(card)).toBe("confirmed");
    expect(await pageTexts(host)).toEqual(confirmedTexts);
    expect(await updateCount(host)).toBe(updates);
  });
});
