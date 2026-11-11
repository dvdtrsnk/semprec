import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant, type AuthenticatedActor, type GenericApplicationPort } from "@semprec/shared";
import { createChokePoint, createCollectionMetadataResolver, loadFullModuleRegistry } from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericApplicationService } from "../genericApplicationService.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let service: GenericApplicationPort;

/** Who wrote the latest update of the page document of `itemId`. */
async function lastAuthorOf(itemId: string): Promise<string | undefined> {
  const { rows } = await runtime.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1
     ORDER BY u.id DESC LIMIT 1`,
    [itemId],
  );
  return rows[0]?.created_by;
}

describe("page.rename through the generic application service (issue #1725)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    service = createGenericApplicationService(
      runtime,
      await createCollectionMetadataResolver(await loadFullModuleRegistry()),
    );
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
  });

  it("returns the stored title and writes the parent's block as the agent for an agent actor, as the user for a person", async () => {
    const userId = randomUUID();
    const person: AuthenticatedActor = { userId, restSession: true };
    await runInTenant(tenant, async () => {
      const chokePoint = createChokePoint(runtime);
      const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
      const host = (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
      const page = (await service.createSubpage(person, { parent: { itemId: host }, title: "Before" })).pages[0];
      if (!page) throw new Error("Missing page");
      const agent: AuthenticatedActor = { userId, runId: randomUUID(), agentProjectItemId: host };

      const byAgent = await service.renamePage(agent, { pageItemId: page.pageItemId, title: " By the\nagent " });
      expect(byAgent).toEqual({ pageItemId: page.pageItemId, title: "By the agent" });
      expect((await service.getItem(person, { itemId: page.pageItemId })).properties.title).toBe("By the agent");
      expect(await lastAuthorOf(host)).toBe("ai_agent");

      const byPerson = await service.renamePage(person, { pageItemId: page.pageItemId, title: "By the person" });
      expect(byPerson).toEqual({ pageItemId: page.pageItemId, title: "By the person" });
      expect(await lastAuthorOf(host)).toBe("user");
    });
  });
});
