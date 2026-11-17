import type { PoolClient } from "pg";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { PropertyOwner, PropertyType } from "../types.js";

/** A property a module seed creates. */
export interface PropSpec {
  key: string;
  /** The stored name. Without one it is null, and the label comes from the module catalog. */
  name?: string | null;
  type: PropertyType;
  owner?: PropertyOwner;
  ownerProcess?: string;
  locked?: boolean;
  config?: Record<string, unknown>;
}

/**
 * A select property's options, each with its color when `colors` names one. An option has no `label`: a shipped
 * option's display text is not an override (see `SelectOption`).
 */
export function selectConfig(options: readonly string[], colors: Record<string, string> = {}): Record<string, unknown> {
  return { options: options.map((key) => ({ key, ...(colors[key] ? { color: colors[key] } : {}) })) };
}

export async function createProps(client: PoolClient, databaseId: string, specs: readonly PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      name: spec.name ?? null,
      type: spec.type,
      owner: spec.owner,
      ownerProcess: spec.ownerProcess,
      locked: spec.locked,
      config: spec.config,
    });
  }
}
