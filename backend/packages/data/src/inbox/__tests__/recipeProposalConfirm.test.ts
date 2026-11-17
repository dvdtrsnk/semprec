import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { readPageBlocks } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { CLOSED_PROPOSAL_STATUSES, getBlob } from "../../blobs/blobsStore.js";
import { sweepUnreferencedBlobs } from "../../blobs/unreferencedBlobSweep.js";
import { createUser } from "../../auth/usersStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { loadDocWithClient } from "../../docs/docPersistence.js";
import { readPageMarkdown } from "../../docs/pageMarkdown.js";
import { ValidationError } from "../../errors.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import type { ItemRow } from "../../types.js";
import { RECIPES_MODULE_ID } from "../../seed/recipesModuleKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  GOULASH_ANSWER,
  PNG_BYTES,
  createRecipeInboxItem,
  htmlPage,
  routedFetch,
  scriptedGateway,
  type PhotoFixture,
} from "../../testSupport/recipeInboxFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createSemprecTickAction, type SemprecTickActionConfig } from "../inboxTickAction.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
  reviseProposalFromThreadWithClient,
  reviseProposalWithClient,
} from "../proposalActions.js";
import { updateProposalValuesWithClient } from "../proposalValueUpdates.js";
import { proposalBlockId } from "../proposalPageContent.js";
import { proposeRecipe, type RecipeProposalPorts } from "../recipeExtraction.js";
import { proposalEnvelopeSchema } from "../proposalEnvelope.js";
import { LOCKED_PROPOSAL_STATUSES } from "../inboxTypesStore.js";

// A recipe proposal from the Inbox tick to the confirm, on the runtime role in a tenant of its own.
const SEEDING_HOOK_TIMEOUT_MS = 90_000;

const PAGE_URL = "https://recipes.example.com/goulash";
const JPEG_BYTES = Buffer.from("\xff\xd8\xff reduced copy for the confirm tests", "latin1");
const PHOTO: PhotoFixture = { reduced: { bytes: JPEG_BYTES, mimeType: "image/jpeg" } };
const IMAGE_URL = "https://cdn.example.com/goulash.png";
const PAGE_WITH_IMAGE = htmlPage(
  `<html><head><meta property="og:image" content="${IMAGE_URL}"></head><body><h1>Beef goulash</h1><p>600 g beef chuck.</p></body></html>`,
);
const PAGE = htmlPage("<h1>Beef goulash</h1><p>600 g beef chuck, 2 onions.</p>");

let adminPool: Pool;
let dataPool: Pool;
let storageDir: string;
let storage: LocalFsBlobStorageWriter;
let tenantId: string;
let tickConfig: SemprecTickActionConfig;

beforeAll(async () => {
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  storageDir = await mkdtemp(join(tmpdir(), "semprec-recipe-confirm-"));
  storage = new LocalFsBlobStorageWriter(storageDir);
  tenantId = await createTestTenant(adminPool);
  // The tick writes the person's texts in the language of the tenant's user.
  await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  tickConfig = await inTenant(async (client) => {
    const id = async (moduleId: string) => {
      const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
      if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
      return database.id;
    };
    return {
      inboxDatabaseId: await id("inbox"),
      inboxItemTypesDatabaseId: await id("inboxItemTypes"),
      processingProposalsDatabaseId: await id("processingProposals"),
    };
  });
}, SEEDING_HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    await rm(storageDir, { recursive: true, force: true });
  } finally {
    await dataPool?.end();
    await adminPool?.end();
  }
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

const cardsOf = () =>
  inTenant((client) => itemsStore.getAllItemsInDatabase(client, tickConfig.processingProposalsDatabaseId));

async function computeCard(itemId: string, ports: RecipeProposalPorts): Promise<ItemRow> {
  const before = new Set((await cardsOf()).map((card) => card.id));
  const tick = createSemprecTickAction(dataPool, (input) =>
    proposeRecipe(ports, input).then((recipe) => recipe ?? { properties: { name: "from the generic computation" } }),
  );
  await runInTenant(tenantId, () => tick(tickConfig, { heartbeatId: "hb", projectItemId: randomUUID(), itemId }));
  const created = (await cardsOf()).filter((card) => !before.has(card.id));
  if (created.length !== 1 || !created[0]) throw new Error(`The tick wrote ${created.length} cards for the item`);
  return created[0];
}

const confirm = (cardId: string) =>
  inTenant((client) =>
    confirmProposalWithClient(
      client,
      { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
      cardId,
    ),
  );

const readCard = async (cardId: string): Promise<ItemRow> => {
  const card = await inTenant((client) =>
    itemsStore.getItemById(client, tickConfig.processingProposalsDatabaseId, cardId),
  );
  if (!card) throw new Error(`Card ${cardId} not found`);
  return card;
};

const recipes = () =>
  inTenant(async (client) => {
    const database = await databasesStore.getDatabaseByModuleId(client, RECIPES_MODULE_ID);
    if (!database) throw new Error("No recipes database");
    return itemsStore.getAllItemsInDatabase(client, database.id);
  });

async function pageOf(itemId: string) {
  return inTenant(async (client) => {
    const page = await readPageMarkdown(client, itemId);
    if (!page.docId) throw new Error("The item has no page");
    const doc = await loadDocWithClient(client, page.docId);
    try {
      const blocks = readPageBlocks(doc).map((block) => ({
        id: block.id,
        type: block.type,
        text: block.text.map((run) => run.insert).join(""),
      }));
      const { rows } = await client.query<{ created_by: string }>(
        "SELECT created_by FROM doc_updates WHERE doc_id = $1",
        [page.docId],
      );
      return { markdown: page.markdown, blocks, authors: rows.map((row) => row.created_by) };
    } finally {
      doc.destroy();
    }
  });
}

describe("a recipe proposal from the Inbox to its confirm (issue gh-1974)", () => {
  it("computes a database proposal for the Recipes database and, once confirmed, creates the recipe with its Ingredients bulleted and its Method numbered", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: `Dinner ${PAGE_URL}` });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: () => Promise.resolve(null),
      photoStorage: storage,
      fetch: routedFetch({ [PAGE_URL]: () => PAGE.clone() }).fetch,
    };

    const card = await computeCard(fixture.itemId, ports);

    const envelope = proposalEnvelopeSchema.parse(card.properties.proposal);
    expect(card.properties.status).toBe("proposed");
    expect(envelope).toEqual({
      entityKind: "database",
      target: fixture.recipesDatabaseId,
      properties: { name: "Beef goulash", prepMinutes: 150, servings: 4, sourceUrl: PAGE_URL },
      pageSections: [
        { heading: "Ingredients", blockType: "bullet", items: GOULASH_ANSWER.ingredients },
        { heading: "Method", blockType: "number", items: GOULASH_ANSWER.steps },
      ],
    });
    expect(card.properties.aiProposal).toEqual(envelope);
    expect(await recipes()).toEqual([]);

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.status).toBe("confirmed");
    const [recipe] = await recipes();
    expect(recipe?.properties).toEqual({ name: "Beef goulash", prepMinutes: 150, servings: 4, sourceUrl: PAGE_URL });
    expect(confirmed.properties.resultItemId).toBe(recipe?.id);
    const page = await pageOf(recipe?.id ?? "");
    // The origin note of the Inbox item comes first, as for every item a card creates; the sections follow it.
    const [note, ...sections] = page.blocks;
    expect(note?.text).toContain(`Dinner ${PAGE_URL}`);
    expect(sections.map(({ type, text }) => [type, text])).toEqual([
      ["h2", "Ingredients"],
      ["bullet", "600 g beef chuck"],
      ["bullet", "2 onions"],
      ["bullet", "1 tbsp paprika"],
      ["h2", "Method"],
      ["number", "Brown the onions."],
      ["number", "Add the beef and paprika."],
      ["number", "Simmer for two hours."],
    ]);
    expect(sections.map((block) => block.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => proposalBlockId(card.id, index)),
    );
    expect(new Set(page.authors)).toEqual(new Set(["user"]));
    expect(readConfirmationResults(confirmed.properties).map((result) => [result.ref, result.blockIds])).toEqual([
      ["primary", sections.map((block) => block.id)],
    ]);
  });

  it("proposes the attached photo's blob as the photo and writes it to the created recipe", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, {
      text: "Grandma's",
      photos: [
        { ...PHOTO, reduced: { bytes: Buffer.from("\xff\xd8\xff confirm photo", "latin1"), mimeType: "image/jpeg" } },
      ],
    });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: (storageKey) => Promise.resolve(storage.readStream(storageKey)),
      photoStorage: storage,
    };

    const card = await computeCard(fixture.itemId, ports);
    const envelope = proposalEnvelopeSchema.parse(card.properties.proposal);
    expect(envelope.properties.photo).toEqual({ blobId: fixture.attachmentBlobIds[0] });
    expect(envelope.properties).not.toHaveProperty("sourceUrl");
    await confirm(card.id);

    const created = (await recipes()).find(
      (recipe) => recipe.properties.name === "Beef goulash" && recipe.properties.photo,
    );
    expect(created?.properties.photo).toEqual({ blobId: fixture.attachmentBlobIds[0] });
    const blob = await inTenant((client) => getBlob(client, fixture.attachmentBlobIds[0] ?? ""));
    expect(blob?.mimeType).toBe("image/jpeg");
    expect((await pageOf(created?.id ?? "")).blocks).toHaveLength(9);
  });

  it("keeps the page sections when the person edits a value of the proposal before confirming", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: `Edit ${PAGE_URL}` });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: () => Promise.resolve(null),
      photoStorage: storage,
      fetch: routedFetch({ [PAGE_URL]: () => PAGE.clone() }).fetch,
    };
    const card = await computeCard(fixture.itemId, ports);

    const edited = await inTenant((client) =>
      updateProposalValuesWithClient(
        client,
        { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
        card.id,
        { set: { primary: { name: "Grandma's goulash", servings: 6 } } },
      ),
    );

    expect(edited.item.properties.userEditedKeys).toEqual(["primary.name", "primary.servings"]);
    expect(proposalEnvelopeSchema.parse(edited.item.properties.proposal).pageSections).toHaveLength(2);
    expect(proposalEnvelopeSchema.parse(edited.item.properties.aiProposal).properties.name).toBe("Beef goulash");
    await confirm(card.id);
    const created = (await recipes()).find((recipe) => recipe.properties.name === "Grandma's goulash");
    expect(created?.properties).toMatchObject({ servings: 6, prepMinutes: 150, sourceUrl: PAGE_URL });
    expect((await pageOf(created?.id ?? "")).blocks.map((block) => block.text)).toContain("2 onions");
  });

  describe("revising the card before the confirm", () => {
    const PROPERTIES = { name: "Goulash for six", prepMinutes: 150, servings: 6, sourceUrl: PAGE_URL };

    async function computeLinkCard(text: string) {
      const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text });
      const ports: RecipeProposalPorts = {
        pool: dataPool,
        gateway: scriptedGateway(() => GOULASH_ANSWER),
        openBlob: () => Promise.resolve(null),
        photoStorage: storage,
        fetch: routedFetch({ [PAGE_URL]: () => PAGE.clone() }).fetch,
      };
      return { fixture, card: await computeCard(fixture.itemId, ports) };
    }

    async function expectRecipePageOfSixKept(card: ItemRow) {
      const revised = await readCard(card.id);
      expect(proposalEnvelopeSchema.parse(revised.properties.proposal).pageSections).toHaveLength(2);
      expect(proposalEnvelopeSchema.parse(revised.properties.aiProposal).pageSections).toHaveLength(2);
      await confirm(card.id);
      const created = (await recipes()).find((recipe) => recipe.properties.name === "Goulash for six");
      expect(created?.properties).toMatchObject({ servings: 6, sourceUrl: PAGE_URL });
      const page = await pageOf(created?.id ?? "");
      expect(page.blocks.slice(1).map(({ type, text }) => [type, text])).toEqual([
        ["h2", "Ingredients"],
        ["bullet", "600 g beef chuck"],
        ["bullet", "2 onions"],
        ["bullet", "1 tbsp paprika"],
        ["h2", "Method"],
        ["number", "Brown the onions."],
        ["number", "Add the beef and paprika."],
        ["number", "Simmer for two hours."],
      ]);
    }

    it("keeps the page sections when the revise route replaces the envelope, and the confirm writes them", async () => {
      const { fixture, card } = await computeLinkCard(`Revise ${PAGE_URL}`);

      await inTenant((client) =>
        reviseProposalWithClient(
          client,
          { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
          card.id,
          { entityKind: "database", target: fixture.recipesDatabaseId, properties: PROPERTIES },
        ),
      );

      await expectRecipePageOfSixKept(card);
    });

    it("keeps the page sections when the assistant of the item thread revises the card, and the confirm writes them", async () => {
      const { fixture, card } = await computeLinkCard(`Thread revise ${PAGE_URL}`);

      await inTenant((client) =>
        reviseProposalFromThreadWithClient(
          client,
          { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
          {
            proposalId: card.id,
            subjectItemId: fixture.itemId,
            threadId: randomUUID(),
            messageId: randomUUID(),
            properties: PROPERTIES,
          },
        ),
      );

      await expectRecipePageOfSixKept(card);
    });
  });

  it("refuses to confirm a recipe whose edited sourceUrl fails the baseline: 400 on sourceUrl, no recipe, no page, the card stays proposed", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: `Internal ${PAGE_URL}` });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: () => Promise.resolve(null),
      photoStorage: storage,
      fetch: routedFetch({ [PAGE_URL]: () => PAGE.clone() }).fetch,
    };
    const card = await computeCard(fixture.itemId, ports);
    await inTenant((client) =>
      updateProposalValuesWithClient(
        client,
        { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
        card.id,
        { set: { primary: { sourceUrl: "https://127.0.0.1/admin" } } },
      ),
    );
    const recipesBefore = (await recipes()).length;

    const error = await confirm(card.id).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { field: "sourceUrl" } });
    expect((await recipes()).length).toBe(recipesBefore);
    expect((await readCard(card.id)).properties.status).toBe("proposed");
  });

  it("refuses to confirm a stored envelope that carries sections on a kind that cannot have them, and writes nothing", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: `Stored ${PAGE_URL}` });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: () => Promise.resolve(null),
      photoStorage: storage,
      fetch: routedFetch({ [PAGE_URL]: () => PAGE.clone() }).fetch,
    };
    const card = await computeCard(fixture.itemId, ports);
    const envelope = proposalEnvelopeSchema.parse(card.properties.proposal);
    // A state no tick produces: the same sections on an envelope that writes to an existing page.
    const pageEnvelope = {
      ...envelope,
      entityKind: "pageContent",
      target: randomUUID(),
      properties: { markdown: "x" },
    };
    await inTenant((client) =>
      updateItemWithClient(
        client,
        {
          databaseId: tickConfig.processingProposalsDatabaseId,
          itemId: card.id,
          propertiesPatch: { proposal: pageEnvelope },
        },
        { allowedSystemKeys: ["proposal"] },
      ),
    );
    const recipesBefore = (await recipes()).length;

    const error = await confirm(card.id).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "pageSections" } });
    expect((await recipes()).length).toBe(recipesBefore);
    expect((await readCard(card.id)).properties.status).toBe("proposed");
  });

  it("falls back to the generic computation when no recipe is read, and writes no page sections", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: "Remember to cook something" });
    const ports: RecipeProposalPorts = {
      pool: dataPool,
      gateway: scriptedGateway(() => GOULASH_ANSWER),
      openBlob: () => Promise.resolve(null),
      photoStorage: storage,
    };

    const card = await computeCard(fixture.itemId, ports);

    const envelope = proposalEnvelopeSchema.parse(card.properties.proposal);
    expect(envelope).toEqual({
      entityKind: "database",
      target: fixture.recipesDatabaseId,
      properties: { name: "from the generic computation" },
    });
    expect(envelope).not.toHaveProperty("pageSections");
  });
  describe("the photo of the page, stored when the card is computed (the unreferenced-blob sweep)", () => {
    const DAYS_LATER_MS = 3 * 24 * 60 * 60 * 1000;

    /** Each card gets image bytes of its own: identical bytes are one blob, which another card's recipe would hold. */
    async function computeCardWithPagePhoto(text: string) {
      const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text });
      const ports: RecipeProposalPorts = {
        pool: dataPool,
        gateway: scriptedGateway(() => ({ ...GOULASH_ANSWER, photoUrl: IMAGE_URL })),
        openBlob: () => Promise.resolve(null),
        photoStorage: storage,
        fetch: routedFetch({
          [PAGE_URL]: () => PAGE_WITH_IMAGE.clone(),
          [IMAGE_URL]: () =>
            new Response(new Uint8Array(Buffer.concat([PNG_BYTES, Buffer.from(text)])), {
              status: 200,
              headers: { "content-type": "image/png" },
            }),
        }).fetch,
      };
      const card = await computeCard(fixture.itemId, ports);
      const blobId = proposalEnvelopeSchema.parse(card.properties.proposal).properties.photo as { blobId: string };
      return { card, blobId: blobId.blobId };
    }

    const sweepAfterDays = () =>
      runInTenant(tenantId, () => sweepUnreferencedBlobs(dataPool, storage, new Date(Date.now() + DAYS_LATER_MS)));
    const blobExists = async (blobId: string) => (await inTenant((client) => getBlob(client, blobId))) !== null;

    it("keeps the blob of an open card past the age of the sweep, and the late confirm writes it to the recipe", async () => {
      const { card, blobId } = await computeCardWithPagePhoto(`Photo ${PAGE_URL}`);
      expect(await blobExists(blobId)).toBe(true);

      await sweepAfterDays();

      expect(await blobExists(blobId)).toBe(true);
      await confirm(card.id);
      const created = (await recipes()).find(
        (recipe) => (recipe.properties.photo as { blobId?: string } | undefined)?.blobId === blobId,
      );
      expect(created?.properties.name).toBe("Beef goulash");
      // The created item holds the reference from the confirm on, and the closed card no longer does.
      await sweepAfterDays();
      expect(await blobExists(blobId)).toBe(true);
    });

    it("keeps the blob of a card the person edited, whose assistant envelope still names it", async () => {
      const { card, blobId } = await computeCardWithPagePhoto(`Edited ${PAGE_URL}`);
      await inTenant((client) =>
        updateProposalValuesWithClient(
          client,
          { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
          card.id,
          { set: { primary: { photo: null } } },
        ),
      );

      await sweepAfterDays();

      expect(await blobExists(blobId)).toBe(true);
    });

    it("collects the blob once the card is rejected", async () => {
      const { card, blobId } = await computeCardWithPagePhoto(`Rejected ${PAGE_URL}`);
      await inTenant((client) =>
        rejectProposalWithClient(
          client,
          { processingProposalsDatabaseId: tickConfig.processingProposalsDatabaseId },
          card.id,
        ),
      );

      await sweepAfterDays();

      expect(await blobExists(blobId)).toBe(false);
    });

    it("counts a card as closed under the same statuses the proposal lock uses", () => {
      expect([...CLOSED_PROPOSAL_STATUSES].sort()).toEqual([...LOCKED_PROPOSAL_STATUSES].sort());
    });
  });
});
