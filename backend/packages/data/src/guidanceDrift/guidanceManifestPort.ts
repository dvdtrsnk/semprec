import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@alldots/module-registry";
import { canonicalizeJson, type GuidanceManifestPort } from "@alldots/shared";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

/**
 * Renders the permission manifest the drift action compares byte-for-byte across its read and write transactions,
 * canonicalized with `canonicalizeJson` (as the fingerprint is) so key order cannot cause a false mismatch.
 */
export function createGuidanceManifestPort(moduleRegistry?: ModuleRegistry): GuidanceManifestPort<PoolClient> {
  return {
    async render(tx, input) {
      const manifest = await generatePermissionManifest(tx, input.projectItemId, {
        moduleRegistry,
        locale: toManifestLocale(input.locale),
      });
      return canonicalizeJson(manifest);
    },
  };
}
