import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type CollectionMetadataResolver,
} from "@semprec/data";
import { CAPABILITY_IDS, runInTenant, SearchOutputSchema, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";

const metadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const WITHOUT_ITEM_READ = new Set(CAPABILITY_IDS.filter((capability) => capability !== "core.item.read"));

let admin: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let tenant: string;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

async function databaseId(moduleKey: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, moduleKey);
    if (!database) throw new Error(`Missing fixture database: ${moduleKey}`);
    return database.id;
  });
}

/** The actor of a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: await databaseId("projects"), properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "search" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

describe("the search operation through the generic operation gateway (issue #1842)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(pool);
  }, 120_000);

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    userId = (await createTenantZeroUser(admin)).id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("returns a valid, schema-conforming answer to a person, an MCP human session and an agent run", async () => {
    await runInTenant(tenant, async () => {
      const task = await chokePoint.createItem({
        databaseId: await databaseId("tasks"),
        properties: { name: "Odeslat fakturu", date: "2026-10-16" },
      });
      const agent = await newAgent();
      for (const actor of [human(), mcpHumanSession(), agent]) {
        const answer = SearchOutputSchema.parse(
          await gateway().invoke("search", actor, ALL_CAPABILITIES, { q: "fakturu", scope: ["task"] }),
        );
        expect(answer.groups).toMatchObject([
          {
            type: "task",
            total: 1,
            items: [{ itemId: task.id, subtitleParts: [{ kind: "date", value: "2026-10-16" }] }],
          },
        ]);
      }
    });
  });

  it("limits an agent run to the databases its project may read, by the run's project and not by a person's session", async () => {
    await runInTenant(tenant, async () => {
      const filesId = await databaseId("files");
      const file = await chokePoint.createItem({ databaseId: filesId, properties: { name: "Faktura.pdf" } });
      const agent = await newAgent();
      // The seeded Files database is open to agents; the flag that makes it need a grant is set directly, since no API sets it on it.
      await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [filesId]);

      const found = (actor: AuthenticatedActor) =>
        gateway()
          .invoke("search", actor, ALL_CAPABILITIES, { q: "faktura", scope: ["file"] })
          .then((answer) =>
            answer.groups.flatMap((group) => group.items.map((item) => ("itemId" in item ? item.itemId : ""))),
          );

      expect(await found(agent)).toEqual([]);
      expect(await found(human())).toEqual([file.id]);
      expect(await found(mcpHumanSession())).toEqual([file.id]);

      await withTransaction(pool, (client) =>
        client.query(
          `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, 'read')`,
          [agent.agentProjectItemId, filesId],
        ),
      );
      expect(await found(agent)).toEqual([file.id]);
    });
  });

  it("does not list or dispatch the operation without core.item.read, and does with it", async () => {
    await runInTenant(tenant, async () => {
      expect(gateway().listOperations(WITHOUT_ITEM_READ)).not.toContain("search");
      expect(gateway().listOperations(ALL_CAPABILITIES)).toContain("search");
      await expect(gateway().invoke("search", human(), WITHOUT_ITEM_READ, { q: "faktura" })).rejects.toMatchObject({
        status: 404,
      });
      await expect(gateway().invoke("search", human(), ALL_CAPABILITIES, { q: "faktura" })).resolves.toEqual({
        groups: [],
      });
    });
  });

  it("refuses an invalid input with a validation error that names the field and does not repeat the query", async () => {
    const secret = "tajny-dotaz-v-chybe";
    await runInTenant(tenant, async () => {
      for (const [input, field] of [
        [{ q: "" }, "q"],
        [{ q: secret.repeat(20) }, "q"],
        [{ q: secret, perGroupLimit: 51 }, "perGroupLimit"],
        [{ q: secret, scope: ["task", "event"], cursor: "abc" }, "cursor"],
      ] as const) {
        const failure = await gateway()
          .invoke("search", human(), ALL_CAPABILITIES, input)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure, JSON.stringify(input).slice(0, 60)).toMatchObject({ status: 400, details: { field } });
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect((failure as Error).message).not.toContain(secret);
      }
    });
  });
});
