import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("select/multi_select option keys (issue #145)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("option validation on write", () => {
    it("accepts a { key } option with no label", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationBasic" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "notDone" }, { key: "done" }] },
      });
      expect(property.config).toEqual({ options: [{ key: "notDone" }, { key: "done" }] });
    });

    it("accepts a { key, label } option", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationLabel" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "custom", label: "Custom label" }] },
      });
      expect(property.config).toEqual({ options: [{ key: "custom", label: "Custom label" }] });
    });

    it("rejects a bare-string option on create", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectString" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: ["notDone"] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an option object missing a string key", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectMissingKey" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ label: "No key" }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an option with an empty-string key", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectEmptyKey" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ key: "" }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a null option element", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectNullElement" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [null] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a non-string label", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectBadLabel" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ key: "custom", label: 42 }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an invalid option on updatePropertyConfig too", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectOnUpdate" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "notDone" }] },
      });
      await expect(chokePoint.updatePropertyConfig(property.id, { options: ["done"] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("does not validate options shape for a non-select property type", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationSkipNonSelect" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "sections",
        name: "Sections",
        type: "longText",
        config: { options: ["purpose", "allowed"] },
      });
      expect(property.config).toEqual({ options: ["purpose", "allowed"] });
    });
  });
});
