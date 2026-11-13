import { describe, expect, it } from "vitest";
import { deriveRunDisplayStatus } from "../agentRuns/agentRunDisplayStatus.js";

describe("deriveRunDisplayStatus (issue #1820)", () => {
  it("is error for a run whose status is error", () => {
    expect(deriveRunDisplayStatus({ status: "error" }, { pending: 0 })).toBe("error");
  });

  it("is error for a failed run even when a request is still pending", () => {
    expect(deriveRunDisplayStatus({ status: "error" }, { pending: 1 })).toBe("error");
  });

  it("is waiting_approval for a done run with one pending request", () => {
    expect(deriveRunDisplayStatus({ status: "done" }, { pending: 1 })).toBe("waiting_approval");
  });

  it("is waiting_approval for a done run with several pending requests", () => {
    expect(deriveRunDisplayStatus({ status: "done" }, { pending: 3 })).toBe("waiting_approval");
  });

  it("is waiting_approval for a run that is still running and has a pending request", () => {
    expect(deriveRunDisplayStatus({ status: "running" }, { pending: 1 })).toBe("waiting_approval");
  });

  it("is running for a running run with nothing pending", () => {
    expect(deriveRunDisplayStatus({ status: "running" }, { pending: 0 })).toBe("running");
  });

  it("is done for a done run without requests", () => {
    expect(deriveRunDisplayStatus({ status: "done" }, { pending: 0 })).toBe("done");
  });

  it("is done for a done run whose requests are decided: a request counted as approved or rejected is not pending", () => {
    // The counts of the run detail for one approved request, queued for execution, and one rejected.
    const counts = { count: 2, pending: 0, approved: 1, rejected: 1 };
    expect(deriveRunDisplayStatus({ status: "done" }, counts)).toBe("done");
  });
});
