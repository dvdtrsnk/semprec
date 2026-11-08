import { describe, expect, it } from "vitest";
import { getTraceContext, getTraceId, mintTraceId, withTraceContext } from "../traceContext.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("mintTraceId", () => {
  it("mints a valid, unique UUID each time", () => {
    const a = mintTraceId();
    const b = mintTraceId();
    expect(a).toMatch(UUID_PATTERN);
    expect(b).toMatch(UUID_PATTERN);
    expect(a).not.toBe(b);
  });
});

describe("getTraceContext / getTraceId", () => {
  it("are undefined outside any withTraceContext call", () => {
    expect(getTraceContext()).toBeUndefined();
    expect(getTraceId()).toBeUndefined();
  });
});

describe("withTraceContext", () => {
  it("mints a fresh valid traceId for a flow with no active context (an entry point)", () => {
    let seen: string | undefined;
    withTraceContext({}, () => {
      seen = getTraceId();
    });
    expect(seen).toMatch(UUID_PATTERN);
  });

  it("reuses the active traceId when nested, only adding the new bindings", () => {
    withTraceContext({ jobName: "mailAccountSync" }, () => {
      const outerTraceId = getTraceId();
      withTraceContext({ agentRunId: "run-1" }, () => {
        expect(getTraceId()).toBe(outerTraceId);
        expect(getTraceContext()).toEqual({ traceId: outerTraceId, jobName: "mailAccountSync", agentRunId: "run-1" });
      });
      // Restored after the nested call returns.
      expect(getTraceContext()).toEqual({ traceId: outerTraceId, jobName: "mailAccountSync" });
    });
  });

  it("honors an explicit traceId binding over any ambient one", () => {
    withTraceContext({ traceId: "outer-trace" }, () => {
      withTraceContext({ traceId: "explicit-trace" }, () => {
        expect(getTraceId()).toBe("explicit-trace");
      });
      expect(getTraceId()).toBe("outer-trace");
    });
  });

  it("returns the wrapped function's value", () => {
    const result = withTraceContext({}, () => 42);
    expect(result).toBe(42);
  });

  it("keeps concurrent async flows isolated from each other", async () => {
    async function flow(label: string, delayMs: number): Promise<{ label: string; traceId: string | undefined }> {
      return withTraceContext({}, async () => {
        const traceId = getTraceId();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // The delay above interleaves with the other flow's execution; the traceId observed
        // after resuming must still be this flow's own, not one it raced with.
        expect(getTraceId()).toBe(traceId);
        return { label, traceId };
      });
    }

    const [a, b] = await Promise.all([flow("a", 10), flow("b", 0)]);
    expect(a.traceId).toBeDefined();
    expect(b.traceId).toBeDefined();
    expect(a.traceId).not.toBe(b.traceId);
  });
});
