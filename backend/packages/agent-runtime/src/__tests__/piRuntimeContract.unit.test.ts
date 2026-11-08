import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  type AgentMessage,
  compact as lowLevelCompact,
  type CompactionPreparation,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Contract suite for the pinned pi runtime (`@earendil-works/pi-ai`,
 * `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`).
 *
 * These tests exercise the real installed packages (no mocking of pi itself) so a
 * `pnpm install` that silently changes the resolved pi version, or a pi release that
 * breaks one of these relied-upon behaviors, fails here with a pi-contract-specific
 * message instead of surfacing later as an unexplained agent-runtime bug.
 */

// Never actually invoked below — these tests only cover construction, not a run —
// so a minimal stand-in cast to `StreamFn` is enough.
const noopStreamFn = async function* () {} as unknown as StreamFn;

// `node:child_process`'s ESM namespace is non-configurable, so `vi.spyOn` on it
// directly is not possible under vitest's module loader. `vi.mock` with a factory
// that wraps every subprocess-spawning export is the supported way to observe calls
// while still letting anything unrelated to this contract keep working normally.
const subprocessSpawnCalls: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrap =
    <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      subprocessSpawnCalls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    spawn: wrap("spawn", actual.spawn),
    exec: wrap("exec", actual.exec),
    execFile: wrap("execFile", actual.execFile),
    fork: wrap("fork", actual.fork),
    spawnSync: wrap("spawnSync", actual.spawnSync),
    execSync: wrap("execSync", actual.execSync),
    execFileSync: wrap("execFileSync", actual.execFileSync),
  };
});

describe("pi runtime contract", () => {
  it("defaults tool execution to parallel", () => {
    const agent = new Agent({ streamFn: noopStreamFn });

    expect(agent.toolExecution).toBe("parallel");
  });

  it("constructs an Agent without spawning a subprocess", () => {
    subprocessSpawnCalls.length = 0;

    new Agent({ streamFn: noopStreamFn });

    expect(subprocessSpawnCalls).toEqual([]);
  });

  it("constructs an AgentSession (createAgentSession) without spawning a subprocess", async () => {
    subprocessSpawnCalls.length = 0;
    const scratchDir = join(tmpdir(), `pi-contract-${process.pid}-${Date.now()}`);

    const modelRuntime = await ModelRuntime.create({
      authPath: join(scratchDir, "auth.json"),
      modelsPath: join(scratchDir, "models.json"),
    });

    const { session } = await createAgentSession({
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      tools: [],
    });
    try {
      expect(subprocessSpawnCalls).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("estimateContextTokens accepts a bare message array with no running session", () => {
    const messages: AgentMessage[] = [
      { kind: "message", role: "user", content: [{ type: "text", text: "hello" }] } as unknown as AgentMessage,
    ];

    const estimate = estimateContextTokens(messages);

    expect(estimate.tokens).toBeGreaterThan(0);
  });

  it("shouldCompact accepts bare numbers and settings with no running session", () => {
    expect(shouldCompact(10, 100, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(shouldCompact(0, 100, { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 0, keepRecentTokens: 0 })).toBe(
      false,
    );
  });

  it("low-level compact() rejects a bare message array in place of a prepared compaction", async () => {
    const messages: AgentMessage[] = [
      { kind: "message", role: "user", content: [{ type: "text", text: "hello" }] } as unknown as AgentMessage,
    ];

    // `compact()` documents its first parameter as `CompactionPreparation` (from
    // `prepareCompaction()`), not a bare `AgentMessage[]`. Casting past the type
    // system to simulate what a caller that skipped `prepareCompaction()` would do
    // proves the low-level function actually depends on that shape at runtime too.
    await expect(
      lowLevelCompact(
        messages as unknown as CompactionPreparation,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();

    // Compile-time half of the same contract: passing a bare AgentMessage[] where a
    // CompactionPreparation is required must fail to type-check. If pi ever widens
    // compact()'s first parameter to accept a bare array, this line stops being an
    // error and `tsc` (run via `pnpm -r run build`) fails on the now-unnecessary
    // `@ts-expect-error`.
    function assertCompactRequiresPreparation() {
      // @ts-expect-error compact() requires a CompactionPreparation, not a bare AgentMessage[]
      void lowLevelCompact(messages, {} as never, {} as never, undefined, undefined, undefined, undefined, {} as never);
    }
    void assertCompactRequiresPreparation;
  });

  it("resourceLoader.systemPromptOverride is the documented hook for replacing the system prompt", async () => {
    const scratchDir = join(tmpdir(), `pi-contract-${process.pid}-${Date.now()}-loader`);
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: scratchDir,
      systemPromptOverride: (base) => `${base ?? ""}\nCONTRACT-MARKER`,
    });

    await loader.reload();

    expect(loader.getSystemPrompt()).toContain("CONTRACT-MARKER");
  });
});
