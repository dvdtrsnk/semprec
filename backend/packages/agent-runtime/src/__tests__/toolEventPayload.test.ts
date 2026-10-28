import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { createAgentRun, insertAgentRunEvent, listAgentRunEvents } from "@semprec/data";
import { createTenantZeroUser, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { runAgentTurn } from "../lifecycleAdapter.js";
import { parseToolEventPayload, type ToolEventMetadata } from "../toolEventPayload.js";
import type { AgentMessage } from "../types.js";

let pool: Pool;
beforeEach(async () => {
  pool ??= getTestPool();
  await resetDatabase(pool);
  await createTenantZeroUser(pool);
});
afterAll(async () => {
  await pool?.end();
});

describe("tool event payload persistence", () => {
  it.each<ToolEventMetadata>([
    { operation: "item.patch" },
    { mcp: { toolRegistrationId: "reg-1", serverItemId: "server-1", serverName: "Search server", toolName: "search" } },
  ])("persists enriched event pairs through the production turn writer (%j)", async (metadata) =>
    runInTenant(getTenantZeroId(), async () => {
      const run = await createAgentRun(pool, { task: "record tool", triggeredBy: "user" });
      const name = metadata.operation ? "item_patch" : "mcp_search";
      const common = { toolCallId: "call-1", name, ...metadata, targetItemId: "item-1", targetDatabaseId: "db-1" };
      const messages: AgentMessage[] = [
        { kind: "tool_use", ...common, arguments: { itemId: "item-1", databaseId: "db-1" } },
        { kind: "tool_result", ...common, result: { content: [{ type: "text", text: "done" }] }, isError: false },
      ];
      async function* stream() {
        yield* messages;
      }
      await runAgentTurn(pool, run.id, stream());
      const rows = await listAgentRunEvents(pool, run.id);
      expect(rows.map((row) => row.payload)).toEqual(messages);
      for (const row of rows) {
        expect(parseToolEventPayload(row.kind, row.payload)).toMatchObject(common);
        expect(Buffer.byteLength(JSON.stringify(row.payload), "utf8")).toBeLessThan(1024 * 1024);
      }
    }),
  );

  it("retains the 1 MiB write refusal for enriched payloads with no event written", async () =>
    runInTenant(getTenantZeroId(), async () => {
      const run = await createAgentRun(pool, { task: "reject oversized tool", triggeredBy: "user" });
      await expect(
        insertAgentRunEvent(pool, run.id, "tool_result", {
          toolCallId: "call-1",
          name: "item_patch",
          operation: "item.patch",
          targetItemId: "item-1",
          result: "x".repeat(1024 * 1024),
          isError: false,
        }),
      ).rejects.toThrow("byte cap");
      expect(await listAgentRunEvents(pool, run.id)).toEqual([]);
    }));
});
