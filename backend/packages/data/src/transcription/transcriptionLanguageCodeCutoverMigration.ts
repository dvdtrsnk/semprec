import type { Pool } from "pg";
import { z } from "zod";
import { normalizeWhisperLanguage } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const computedSchema = z.record(z.string(), z.unknown());
const asrSchema = z.object({ language: z.string().nullable().optional() }).passthrough();
const PAGE_SIZE = 100;

/** Converts legacy language names per tenant, in locked keyset pages, without realtime announcements. */
export async function runTranscriptionLanguageCodeCutoverMigration(pool: Pool): Promise<void> {
  for (const moduleId of [TRANSCRIPTS_MODULE_ID, FILES_MODULE_ID]) {
    let afterId: string | null = null;
    for (;;) {
      const next: string | null = await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) return null;
        const key = moduleId === FILES_MODULE_ID ? "asr" : "language";
        const { rows } = await client.query<{ id: string; computed: unknown }>(
          `SELECT id, computed FROM items WHERE database_id = $1
             AND ($2::uuid IS NULL OR id > $2) AND computed ? $3
           ORDER BY id LIMIT $4 FOR UPDATE`,
          [database.id, afterId, key, PAGE_SIZE],
        );
        for (const row of rows) {
          const computed = computedSchema.parse(row.computed);
          const asr = key === "asr" ? asrSchema.parse(computed.asr) : null;
          const raw = asr ? asr.language : z.string().nullable().parse(computed.language);
          const normalized = normalizeWhisperLanguage(raw);
          if (raw === normalized) continue;
          await writeComputed(client, database.id, row.id, key, asr ? { ...asr, language: normalized } : normalized);
        }
        return rows.length === PAGE_SIZE ? rows[rows.length - 1]!.id : null;
      });
      if (next === null) break;
      afterId = next;
    }
  }
}
