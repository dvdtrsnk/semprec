import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  compact as lowLevelCompact,
  createAgentSession,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";

/** pi-coding-agent no longer exports the name of `compact()`'s first parameter. */
type CompactionPreparation = Parameters<typeof lowLevelCompact>[0];

/**
 * Contract suite for the pinned pi runtime (`pi-ai`, `pi-agent-core`, `pi-coding-agent`), run against the real
 * installed packages, so a version change that breaks a relied-upon behavior fails here with a pi-specific message.
 */

// Never invoked: these tests cover construction only.
const noopStreamFn = async function* () {} as unknown as StreamFn;

// `node:child_process`'s ESM namespace is non-configurable, so `vi.spyOn` cannot wrap it; `vi.mock` with a wrapping
// factory observes calls while leaving everything else working.
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

  it("estimateTokens sizes a bare message with no running session", () => {
    const message: Message = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 };

    expect(estimateTokens(message)).toBeGreaterThan(0);
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

    // Casting past the type system to skip `prepareCompaction()` proves `compact()` depends on that shape at runtime.
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
