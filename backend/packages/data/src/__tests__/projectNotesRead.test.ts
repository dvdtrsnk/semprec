import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { mutateDoc } from "../docs/docPersistence.js";
import { readProjectNotes } from "../docs/projectNotesRead.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestProjectItem, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
beforeAll(async () => { admin = getTestPool(); runtime = await createRuntimeRolePool(admin, "semprec_data"); });
beforeEach(async () => { await resetDatabase(admin); tenant = await createTestTenant(admin); await runInTenant(tenant, () => seedSystem(runtime)); });
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("project notes read", () => {
  it("preserves each page block caption, including repeated page ids", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    const doc = await runInTenant(tenant, () => withTransaction(runtime, (tx) => getOrCreateDoc(tx, project, "page")));
    const pageId = randomUUID();
    await runInTenant(tenant, () => mutateDoc(runtime, doc.id, "user", (ydoc) => {
      writeBlock(ydoc, { id: randomUUID(), type: "page", pageId, text: "First title" });
      writeBlock(ydoc, { id: randomUUID(), type: "page", pageId, text: "Second title" });
    }));
    const notes = await runInTenant(tenant, () => withTransaction(runtime, (tx) => readProjectNotes(tx, project)));
    expect(notes?.subpages).toEqual([{ id: pageId, title: "First title" }, { id: pageId, title: "Second title" }]);
    expect(notes?.markdown).toContain(`[First title](semprec://page/${pageId})`);
    expect(notes?.markdown).toContain(`[Second title](semprec://page/${pageId})`);
  });
  it("does not create missing pages and treats a canvas as no notes under tenant scope", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    expect(await runInTenant(tenant, () => withTransaction(runtime, (tx) => readProjectNotes(tx, project)))).toBeNull();
    await runInTenant(tenant, () => withTransaction(runtime, (tx) => getOrCreateDoc(tx, project, "canvas")));
    expect(await runInTenant(tenant, () => withTransaction(runtime, (tx) => readProjectNotes(tx, project)))).toBeNull();
    const other = await createTestTenant(admin);
    expect(await runInTenant(other, () => withTransaction(runtime, (tx) => readProjectNotes(tx, project)))).toBeNull();
  });
});
