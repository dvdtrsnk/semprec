import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant, type AuthenticatedActor, type GenericApplicationPort } from "@semprec/shared";
import { createChokePoint, createCollectionMetadataResolver, createUser, loadFullModuleRegistry } from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericApplicationService } from "../genericApplicationService.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let service: GenericApplicationPort;

/** The one user of the tenant, with the given locale; the password hash is never used. */
async function userWithLocale(locale: string): Promise<string> {
  const user = await createUser(admin, {
    tenantId: tenant,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale,
  });
  return user.id;
}

/** A host item with one subpage titled "Release checklist"; returns both ids. */
async function hostWithPage(actor: AuthenticatedActor): Promise<{ host: string; pageItemId: string }> {
  const chokePoint = createChokePoint(runtime);
  const database = await chokePoint.createDatabase({ name: `Hosts ${randomUUID()}` });
  const host = (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
  const created = await service.createSubpage(actor, { parent: { itemId: host }, title: "Release checklist" });
  const page = created.pages[0];
  if (!page) throw new Error("Missing page");
  return { host, pageItemId: page.pageItemId };
}

async function titleOf(actor: AuthenticatedActor, itemId: string): Promise<unknown> {
  return (await service.getItem(actor, { itemId })).properties.title;
}

/** Who wrote the latest update of the page document of `itemId`. */
async function lastAuthorOf(itemId: string): Promise<string | undefined> {
  const { rows } = await runtime.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1
     ORDER BY u.id DESC LIMIT 1`,
    [itemId],
  );
  return rows[0]?.created_by;
}

describe("page.duplicate through the generic application service (issue #1722)", () => {
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

  it.each([
    ["cs", "Release checklist (kopie)"],
    ["en", "Release checklist (copy)"],
  ])("titles the copy for a user whose locale is %s as '%s'", async (locale, expected) => {
    const actor: AuthenticatedActor = { userId: await userWithLocale(locale), restSession: true };
    await runInTenant(tenant, async () => {
      const { pageItemId } = await hostWithPage(actor);

      const copy = await service.duplicatePage(actor, { pageItemId });

      expect(await titleOf(actor, copy.pageItemId)).toBe(expected);
    });
  });

  it("titles the copy in English when the acting user is not found", async () => {
    // The tenant's own user is Czech, so an English suffix can only come from the fallback.
    const known: AuthenticatedActor = { userId: await userWithLocale("cs"), restSession: true };
    const unknown: AuthenticatedActor = { userId: randomUUID(), restSession: true };
    await runInTenant(tenant, async () => {
      const { pageItemId } = await hostWithPage(known);

      const copy = await service.duplicatePage(unknown, { pageItemId });

      expect(await titleOf(known, copy.pageItemId)).toBe("Release checklist (copy)");
    });
  });

  it("authors the copy as the agent for an agent actor and as the user for a person", async () => {
    const userId = await userWithLocale("en");
    const person: AuthenticatedActor = { userId, restSession: true };
    await runInTenant(tenant, async () => {
      const { host, pageItemId } = await hostWithPage(person);
      expect(await lastAuthorOf(host)).toBe("user");
      const agent: AuthenticatedActor = { userId, runId: randomUUID(), agentProjectItemId: host };

      await service.duplicatePage(agent, { pageItemId });
      expect(await lastAuthorOf(host)).toBe("ai_agent");

      await service.duplicatePage(person, { pageItemId });
      expect(await lastAuthorOf(host)).toBe("user");
    });
  });
});
