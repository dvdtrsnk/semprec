import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { canonicalizeJson, type GuidanceManifestPort } from "@semprec/shared";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceManifestPort` (issue #85):
 * renders the same project/user/locale's permission manifest (#147) the drift action compares
 * byte-for-byte across its read and write transactions. Canonicalized (sorted object keys, no
 * whitespace) via the same `canonicalizeJson` the fingerprint algorithm uses, so the equality
 * check is robust to incidental key-order differences between two renders rather than depending
 * on `generatePermissionManifest`'s object-construction order staying literally identical.
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
