import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  GOULASH_ANSWER,
  createRecipeInboxItem,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  htmlPage,
  resetDatabase,
  routedFetch,
  scriptedGateway,
  type PhotoFixture,
} from "@alldots/data/testSupport";
import {
  LocalFsBlobStorageWriter,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
} from "@alldots/data";
import { runInTenant } from "@alldots/shared";
import type { AresClient } from "../aresClient.js";
import { createProposalComputation } from "../proposalComputation.js";

// The recipe proposal writer is registered in the Inbox proposal computation's composition root: an item computed for
// the Recipes database is read as a recipe first, and any other outcome goes on unchanged.

const SEEDING_HOOK_TIMEOUT_MS = 90_000;
const PAGE_URL = "https://recipes.example.com/goulash";
const PHOTO: PhotoFixture = {
  reduced: { bytes: Buffer.from("\xff\xd8\xff composition photo", "latin1"), mimeType: "image/jpeg" },
};
const GENERIC_ANSWER = { properties: { name: "A generic proposal" } };
const knowsNoCompany: AresClient = {
  async lookupCompanyByIco() {
    return null;
  },
};

let adminPool: Pool;
let dataPool: Pool;
let storageDir: string;
let storage: LocalFsBlobStorageWriter;
let tenantId: string;

beforeAll(async () => {
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
  storageDir = await mkdtemp(join(tmpdir(), "alldots-recipe-composition-"));
  storage = new LocalFsBlobStorageWriter(storageDir);
  tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}, SEEDING_HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    await rm(storageDir, { recursive: true, force: true });
  } finally {
    await dataPool?.end();
    await adminPool?.end();
  }
});

describe("the proposal computation and the recipe writer (issue gh-1974)", () => {
  it("answers an item computed for the Recipes database with the recipe it reads from the link, and makes no other call", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: PAGE_URL });
    const gateway = scriptedGateway(() => GOULASH_ANSWER);
    const fetch = routedFetch({ [PAGE_URL]: () => htmlPage("<h1>Goulash</h1><p>Beef, onions.</p>") });
    const compute = createProposalComputation({
      pool: dataPool,
      gateway,
      openBlob: () => Promise.resolve(null),
      aresClient: knowsNoCompany,
      recipe: { photoStorage: storage, fetch: fetch.fetch },
    });

    const result = await runInTenant(tenantId, () => compute(fixture.input));

    expect(result.properties).toEqual({ name: "Beef goulash", prepMinutes: 150, servings: 4, sourceUrl: PAGE_URL });
    expect(result.pageSections?.map((section) => section.blockType)).toEqual(["bullet", "number"]);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.system).toContain("cooking recipe");
  });

  it("goes on with the ordinary proposal call when the page holds no recipe, after the one call that found none", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: PAGE_URL });
    const gateway = scriptedGateway((call) => (call === 1 ? { name: "", ingredients: [], steps: [] } : GENERIC_ANSWER));
    const fetch = routedFetch({ [PAGE_URL]: () => htmlPage("<p>Opening hours</p>") });
    const compute = createProposalComputation({
      pool: dataPool,
      gateway,
      openBlob: () => Promise.resolve(null),
      aresClient: knowsNoCompany,
      recipe: { photoStorage: storage, fetch: fetch.fetch },
    });

    const result = await runInTenant(tenantId, () => compute(fixture.input));

    expect(result.properties).toEqual({ name: "A generic proposal" });
    expect(result).not.toHaveProperty("pageSections");
    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[0]?.system).toContain("cooking recipe");
    expect(gateway.calls[1]?.system).toContain("turn one captured Inbox item into a proposal");
  });

  it("does not read the photo as a document when it reads it as a recipe", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: "", photos: [PHOTO] });
    const gateway = scriptedGateway(() => GOULASH_ANSWER);
    const compute = createProposalComputation({
      pool: dataPool,
      gateway,
      openBlob: (storageKey) => Promise.resolve(storage.readStream(storageKey)),
      aresClient: knowsNoCompany,
      recipe: { photoStorage: storage },
    });

    const result = await runInTenant(tenantId, () => compute(fixture.input));

    expect(result.properties).toMatchObject({ name: "Beef goulash", photo: { blobId: fixture.attachmentBlobIds[0] } });
    expect(gateway.calls.map((call) => call.operation)).toEqual(["inbox_proposal"]);
  });

  it("has no recipe writer without the recipe ports: the link is not requested and the ordinary call is made", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: PAGE_URL });
    const gateway = scriptedGateway(() => GENERIC_ANSWER);
    const fetch = routedFetch({ [PAGE_URL]: () => htmlPage("<p>x</p>") });
    const compute = createProposalComputation({
      pool: dataPool,
      gateway,
      openBlob: () => Promise.resolve(null),
      aresClient: knowsNoCompany,
    });

    const result = await runInTenant(tenantId, () => compute(fixture.input));

    expect(result.properties).toEqual({ name: "A generic proposal" });
    expect(fetch.requested).toEqual([]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("leaves an item computed for another database alone, a link in its text included", async () => {
    const fixture = await createRecipeInboxItem(dataPool, storage, tenantId, { text: PAGE_URL });
    const gateway = scriptedGateway(() => GENERIC_ANSWER);
    const fetch = routedFetch({ [PAGE_URL]: () => htmlPage("<p>x</p>") });
    const compute = createProposalComputation({
      pool: dataPool,
      gateway,
      openBlob: () => Promise.resolve(null),
      aresClient: knowsNoCompany,
      recipe: { photoStorage: storage, fetch: fetch.fetch },
    });
    const tasks = await runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!tasks) throw new Error("The tasks database was not seeded");
    const tasksInput = { ...fixture.input, targetDatabaseId: tasks.id, targetModuleId: "tasks" };

    const result = await runInTenant(tenantId, () => compute(tasksInput));

    expect(result.properties).toEqual({ name: "A generic proposal" });
    expect(fetch.requested).toEqual([]);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.system).not.toContain("cooking recipe");
  });
});
