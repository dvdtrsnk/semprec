import type { PoolClient } from "pg";
import { z } from "zod";
import type { ModuleLinkRuleEndpoint } from "@semprec/module-registry";
import type { ValueLinkSourceInput } from "../chokePoint/valueLinksStore.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

export interface LinkRuleResolution {
  /** At most the values the target property allows. */
  values: string[];
  /** In no particular order; a resolution without values has none. */
  sources: ValueLinkSourceInput[];
}

export interface LinkRuleResolverInputs {
  edges: Array<{ databaseKey: string; relationKey: string }>;
  /**
   * `onAppear`: an item's creation and restore are inputs too. Off by default: a created item usually has no relations
   * yet, and its edges are inputs of their own.
   */
  properties: Array<{ databaseKey: string; propertyKey: string; onAppear?: boolean }>;
}

/** Exported by a module and named by its manifest. Runs in the caller's tenant transaction; both functions only read. */
export interface LinkRuleResolver {
  inputs: LinkRuleResolverInputs;
  resolve(client: PoolClient, itemId: string): Promise<LinkRuleResolution>;
  /** Target-database items whose answer `changedItemId` may have changed, ascending after `afterId`, itself included. */
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

/** Wraps the export so what it returns is validated where it enters the engine; a non-resolver fails the rule load. */
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

/** Validated once per process like `loadLinkRules`. */
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
