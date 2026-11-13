import { describe, expect, it, vi } from "vitest";
import type { ModuleCatalogs } from "@semprec/module-registry";

const loadModuleCatalogs = vi.hoisted(() => vi.fn<(modulePath: string) => Promise<ModuleCatalogs>>());

vi.mock("@semprec/module-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/module-registry")>()),
  loadModuleCatalogs,
}));

import { agentRunErrorSummary } from "../agentRuns/agentRunErrorSummary.js";

describe("agentRunErrorSummary catalog loading (issue #1824)", () => {
  it("does not keep a failed load: the next call loads the catalogs again and the one after reuses them", async () => {
    loadModuleCatalogs.mockRejectedValueOnce(new Error("catalog unreadable"));
    loadModuleCatalogs.mockResolvedValue({
      cs: { "agentRun.error.internal.summary": "cs text" },
      en: { "agentRun.error.internal.summary": "en text" },
    });

    await expect(agentRunErrorSummary("internal", "en")).rejects.toThrow("catalog unreadable");
    await expect(agentRunErrorSummary("internal", "en")).resolves.toBe("en text");
    await expect(agentRunErrorSummary("internal", "cs")).resolves.toBe("cs text");

    expect(loadModuleCatalogs).toHaveBeenCalledTimes(2);
  });
});
