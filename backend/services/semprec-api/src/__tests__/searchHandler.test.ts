import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, getDatabaseByModuleId, seedSystem, withTransaction } from "@semprec/data";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const searchBody = z.object({
  groups: z.array(
    z.object({
      type: z.string(),
      total: z.number(),
      items: z.array(z.object({ itemId: z.string(), title: z.string() }).passthrough()),
      nextCursor: z.string().nullable(),
    }),
  ),
});
const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.object({ field: z.string() }).optional() }),
});

interface Answer {
  status: number;
  text: string;
}

async function get(headers: Record<string, string> | undefined, query: string): Promise<Answer> {
  const response = await fetch(`${harness.baseUrl}/api/search?${query}`, { headers });
  return { status: response.status, text: await response.text() };
}

/** A Task titled `title` in `tenantId`, written through the choke point; returns its id. */
async function createTask(tenantId: string, title: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const tasks = await withTransaction(harness.runtime, (client) => getDatabaseByModuleId(client, "tasks"));
    if (!tasks) throw new Error("Tasks was not seeded");
    return (await createChokePoint(harness.runtime).createItem({ databaseId: tasks.id, properties: { name: title } }))
      .id;
  });
}

describe("GET /api/search (issue #1842)", () => {
  beforeAll(() => harness.start());
  beforeEach(async () => {
    await harness.reset();
    for (const tenantId of [harness.tenantA, harness.tenantB]) {
      await runInTenant(tenantId, () => seedSystem(harness.runtime));
    }
  }, 120_000);
  afterAll(() => harness.stop());

  it("answers a signed-in caller with the groups of the caller's own tenant, and an anonymous caller with 401", async () => {
    const own = await createTask(harness.tenantA, "Faktura od klienta");
    const foreign = await createTask(harness.tenantB, "Faktura cizí");

    const answer = await get(harness.headersA, "q=faktura");
    expect(answer.status, answer.text).toBe(200);
    const body = searchBody.parse(JSON.parse(answer.text));
    expect(body.groups.map((group) => [group.type, group.total, group.items.map((item) => item.itemId)])).toEqual([
      ["task", 1, [own]],
    ]);
    expect(answer.text).not.toContain(foreign);

    expect((await get(undefined, "q=faktura")).status).toBe(401);
  });

  it("decodes a query with spaces and accents, takes scope as a comma list or as a repeated parameter, and honours perGroupLimit", async () => {
    await createTask(harness.tenantA, "Odeslat fakturu klientovi");
    await createTask(harness.tenantA, "Odeslat fakturu dodavateli");
    const encoded = encodeURIComponent("odeslat fakturu");
    const commas = await get(harness.headersA, `q=${encoded}&scope=task,event&perGroupLimit=1`);
    const repeated = await get(harness.headersA, `q=${encoded}&scope=task&scope=event&perGroupLimit=1`);
    expect(commas.status, commas.text).toBe(200);
    expect(JSON.parse(repeated.text)).toEqual(JSON.parse(commas.text));
    const task = searchBody.parse(JSON.parse(commas.text)).groups[0];
    expect([task?.type, task?.total, task?.items.length]).toEqual(["task", 2, 1]);
    // An event scope alone finds none of these tasks.
    expect(JSON.parse((await get(harness.headersA, `q=${encoded}&scope=event`)).text)).toEqual({ groups: [] });
  });

  it("continues a group with the cursor of the previous page", async () => {
    const ids = await Promise.all([1, 2, 3].map((n) => createTask(harness.tenantA, `Faktura ${n}`)));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const answer = await get(harness.headersA, `q=faktura&scope=task&perGroupLimit=2${suffix}`);
      expect(answer.status, answer.text).toBe(200);
      const group = searchBody.parse(JSON.parse(answer.text)).groups[0];
      seen.push(...(group?.items.map((item) => item.itemId) ?? []));
      cursor = group?.nextCursor ?? null;
      if (cursor === null) break;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it.each([
    ["a missing query", "scope=task", "q"],
    ["an empty query", "q=", "q"],
    ["a query over 200 characters", `q=${"a".repeat(201)}`, "q"],
    ["a limit over 50", "q=secretword&perGroupLimit=51", "perGroupLimit"],
    ["a limit of 0", "q=secretword&perGroupLimit=0", "perGroupLimit"],
    ["a limit that is not a number", "q=secretword&perGroupLimit=many", "perGroupLimit"],
    ["a limit that is not whole", "q=secretword&perGroupLimit=1.5", "perGroupLimit"],
    ["an unknown scope type", "q=secretword&scope=recipe", "scope"],
    ["an empty scope", "q=secretword&scope=", "scope"],
    ["a repeated scope type", "q=secretword&scope=task,task", "scope"],
    ["a cursor with two scope types", "q=secretword&scope=task,event&cursor=abc", "cursor"],
    ["a cursor without a scope", "q=secretword&cursor=abc", "cursor"],
    ["a cursor that was not issued", "q=secretword&scope=task&cursor=abc", "cursor"],
  ])(
    "answers %s with 400 validation_failed naming the field and not repeating the query",
    async (_label, query, field) => {
      const answer = await get(harness.headersA, query);
      expect(answer.status, answer.text).toBe(400);
      const body = errorBody.parse(JSON.parse(answer.text));
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details?.field).toMatch(new RegExp(`^${field}(\\.\\d+)?$`));
      expect(answer.text).not.toContain("secretword");
      expect(answer.text).not.toContain("aaaaaaaaaa");
    },
  );
});
