import type { PoolClient } from "pg";
import { z } from "zod";
import type { ModuleLinkRuleEndpoint } from "@semprec/module-registry";
import type { ValueLinkSourceInput } from "../chokePoint/valueLinksStore.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

/** What a resolver says the target property of one item holds: the related item ids and where they come from. */
export interface LinkRuleResolution {
  /** Ids of the items the target relation should hold; at most the values the target property allows. */
  values: string[];
  /** The sources recorded on the link, in no particular order. A resolution without values has none. */
  sources: ValueLinkSourceInput[];
}

/** The changes that make a resolver's answer stale: an edge of a relation property or a plain property. */
export interface LinkRuleResolverInputs {
  edges: Array<{ databaseKey: string; relationKey: string }>;
  /**
   * `onAppear`: the creation of an item that holds the property, and its restore from the trash, are inputs too, not
   * only an update of the property. Off by default: a created item usually has no relations yet, and its relation
   * edges are inputs of their own.
   */
  properties: Array<{ databaseKey: string; propertyKey: string; onAppear?: boolean }>;
}

/**
 * A module's computation of a link rule's value (`ModuleResolverLinkRuleDescriptor`). The module exports an
 * object of this shape and the manifest names the export. The engine runs it inside the caller's tenant
 * transaction; both functions only read.
 */
export interface LinkRuleResolver {
  inputs: LinkRuleResolverInputs;
  /** The value and sources the target property of item `itemId` has now. */
  resolve(client: PoolClient, itemId: string): Promise<LinkRuleResolution>;
  /**
   * The items of the rule's target database whose answer a change of `changedItemId` may have changed, in
   * ascending id order, after `afterId`. The item that carries the target property itself is such an item.
   */
  affectedItemIds(client: PoolClient, changedItemId: string, afterId: string | null, limit: number): Promise<string[]>;
}

export interface ResolverLinkRule {
  moduleId: string;
  key: string;
  target: ModuleLinkRuleEndpoint;
  resolver: LinkRuleResolver;
}

const inputsSchema = z
  .object({
    edges: z.array(z.object({ databaseKey: z.string().min(1), relationKey: z.string().min(1) }).strict()),
    properties: z.array(
      z
        .object({ databaseKey: z.string().min(1), propertyKey: z.string().min(1), onAppear: z.boolean().optional() })
        .strict(),
    ),
  })
  .strict();

const resolutionSchema = z
  .object({
    values: z.array(z.uuid()),
    sources: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("item"), sourceItemId: z.uuid(), sourcePropertyKey: z.string().min(1) }).strict(),
        z
          .object({ kind: z.literal("senderDomain"), domain: z.string().min(1), sourcePropertyKey: z.string().min(1) })
          .strict(),
      ]),
    ),
  })
  .strict();

const idListSchema = z.array(z.uuid());

/**
 * Checks the export a manifest named as a rule's resolver and wraps it, so what it returns is validated
 * where it enters the engine. A value that is not a resolver fails the load of the rules.
 */
export function parseLinkRuleResolver(ruleKey: string, value: object): LinkRuleResolver {
  if (!("inputs" in value) || !("resolve" in value) || !("affectedItemIds" in value))
    throw new Error(`Link rule "${ruleKey}" resolver must declare inputs, resolve and affectedItemIds`);
  const { inputs, resolve, affectedItemIds } = value;
  if (typeof resolve !== "function" || typeof affectedItemIds !== "function")
    throw new Error(`Link rule "${ruleKey}" resolver must declare inputs, resolve and affectedItemIds`);
  const parsedInputs = inputsSchema.parse(inputs);
  return {
    inputs: parsedInputs,
    resolve: async (client, itemId) => resolutionSchema.parse(await resolve.call(value, client, itemId)),
    affectedItemIds: async (client, changedItemId, afterId, limit) =>
      idListSchema.parse(await affectedItemIds.call(value, client, changedItemId, afterId, limit)),
  };
}

let resolverRulesPromise: Promise<ResolverLinkRule[]> | undefined;

/** The resolver rules of the active modules, validated once per process like `loadLinkRules`. */
export function loadResolverLinkRules(): Promise<ResolverLinkRule[]> {
  resolverRulesPromise ??= loadFullModuleRegistry()
    .then(async (registry) =>
      (await registry.getLinkResolverRules()).map((rule) => ({
        moduleId: rule.moduleId,
        key: rule.key,
        target: rule.target,
        resolver: parseLinkRuleResolver(rule.key, rule.resolver),
      })),
    )
    .catch((error: unknown) => {
      resolverRulesPromise = undefined;
      throw error;
    });
  return resolverRulesPromise;
}
