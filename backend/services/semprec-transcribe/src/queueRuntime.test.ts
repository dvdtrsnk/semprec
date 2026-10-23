import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { ModuleRegistry } from "@semprec/module-registry";
import { createTranscribeQueueRuntime, type TranscribeQueueRuntime } from "./queueRuntime.js";

function fixturePath(name: string): string {
  return new URL(`./__tests__/fixtures/${name}`, import.meta.url).href;
}

let pool: Pool;
let runtime: TranscribeQueueRuntime | undefined;

describe("createTranscribeQueueRuntime", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects an active transcribe-affinity module task without a local handler", async () => {
    const registry = new ModuleRegistry(() => new Set(["fixture-transcribe-queue-runtime"]));
    await registry.loadModule(fixturePath("transcribeFixtureModule.js"));

    await expect(createTranscribeQueueRuntime(pool, registry)).rejects.toThrow(
      /missing handler\(s\) for: transcribeFixture.doThing/,
    );
  });
});
