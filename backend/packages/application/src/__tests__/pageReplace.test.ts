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

/** Who stored each update of the page document of `itemId`, oldest first. */
async function authorsOf(itemId: string): Promise<string[]> {
  const { rows } = await runtime.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
    [itemId],
  );
  return rows.map((row) => row.created_by);
}

describe("page.replace through the generic application service (issue #1765)", () => {
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

  it("stores every update as the agent for an agent actor and as the user for a person, including the trash of a vanished page", async () => {
    const userId = randomUUID();
    const person: AuthenticatedActor = { userId, restSession: true };
    await runInTenant(tenant, async () => {
      const chokePoint = createChokePoint(runtime);
      const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
      const host = (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
      await service.insertPage(person, { itemId: host, placement: "end", markdown: "Intro" });
      const first = (await service.createSubpage(person, { parent: { itemId: host }, title: "First" })).pages[0];
      const second = (await service.createSubpage(person, { parent: { itemId: host }, title: "Second" })).pages[0];
      if (!first || !second) throw new Error("Missing page");
      const agent: AuthenticatedActor = { userId, runId: randomUUID(), agentProjectItemId: host };
      const read = async () => {
        const page = await service.getPage(person, { itemId: host, format: "markdown" });
        if (!("markdown" in page)) throw new Error("Missing markdown");
        return page;
      };

      const settled = (await authorsOf(host)).length;
      const byAgent = await service.replacePage(agent, {
        itemId: host,
        markdown: `Intro by the agent\n\n[Second](semprec://page/${second.pageItemId})`,
        expectedEtag: (await read()).etag,
      });
      expect(byAgent.trashedPages).toEqual([{ pageItemId: first.pageItemId, title: "First" }]);
      expect((await authorsOf(host)).slice(settled)).toEqual(["ai_agent", "ai_agent"]);

      const afterAgent = await read();
      const byPerson = await service.replacePage(person, {
        itemId: host,
        markdown: "Intro by the person",
        expectedEtag: afterAgent.etag,
      });
      expect(byPerson.trashedPages).toEqual([{ pageItemId: second.pageItemId, title: "Second" }]);
      expect((await authorsOf(host)).slice(settled + 2)).toEqual(["user", "user"]);
      expect(byPerson.etag).toBe((await read()).etag);
    });
  });
});
