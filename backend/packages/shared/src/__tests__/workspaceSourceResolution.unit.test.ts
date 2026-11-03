import { expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { runInTenant as sourceRunInTenant } from "../index.js";

it("resolves the shared workspace root to the source module in the unit tier", () => {
  expect(runInTenant).toBe(sourceRunInTenant);
});
