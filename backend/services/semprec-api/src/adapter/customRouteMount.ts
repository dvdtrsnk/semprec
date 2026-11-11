import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type {
  HeartbeatRuleKindRegistry,
  MailSendAdapterFactory,
  VerifiedMailServerSettings,
  VerifyMailCredentialsInput,
} from "@semprec/data";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import { mountRoutes, type RouteDefinition } from "./routeTable.js";
import type { AdapterHandler } from "./adapterRoute.js";

/** One provider's OAuth client: the id and secret the composition root read from the environment. */
export interface CustomRouteOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** OAuth settings for the connect routes (issue #1686). Every member is absent when the composition root did not configure it. */
export interface CustomRouteOAuthConfig {
  gmail?: CustomRouteOAuthClient;
  msGraph?: CustomRouteOAuthClient;
  /** The base URL a provider redirects back to: the composition root's `APP_BASE_URL`. */
  redirectBaseUrl?: string;
}

/** The mail server clients the password and send routes use (issues #1736 and #1896). */
export interface MailServerClients {
  /**
   * Verifies the login in the password connect route (issue gh-1736, `mail/mailboxPasswordRouteHandlers.ts`):
   * resolves with the IMAP and SMTP endpoints that accepted the login, and rejects when none did. Runs
   * before any mailbox is stored. `serve.ts` sets it to `verifyMailCredentials`. A mount without it fails
   * each request of that route with a configuration error.
   */
  verifyPassword?: (input: VerifyMailCredentialsInput) => Promise<VerifiedMailServerSettings>;
  /** The SMTP transports `sendDraftEmail` takes (mail/send.ts). */
  send?: MailSendAdapterFactory;
}

/** The per-mailbox control of the mail live-sync root that the mailbox routes call (issues #1686, #1690 and #1742). */
export interface MailLiveSyncControl {
  startMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
  stopMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
  /** Replaces the mailbox's hosted lifecycle (`MailLiveSyncRoot.restartAccount`); a reauthorization calls it after its commit. */
  restartAccount(mailboxItemId: string): Promise<void>;
}

/**
 * What the composition root (`serve.ts`) hands every module custom route beyond its database pool.
 * Every member is optional: the root sets only what it configured. A route reads its member through
 * `requireCustomRouteDependency` when it runs, so a route that does not use a member never notices
 * that it is absent.
 */
export interface CustomRouteDependencies {
  heartbeatRuleKinds?: () => Promise<HeartbeatRuleKindRegistry>;
  oauth?: CustomRouteOAuthConfig;
  mailServerClients?: MailServerClients;
  mailLiveSync?: MailLiveSyncControl;
  /** Replaces the global `fetch` for outbound calls to providers. */
  outboundHttp?: typeof fetch;
}

/**
 * The shape every module custom route's `handlerExport` (issue #239's manifest field) must
 * resolve to: a factory the mount calls once at startup with the `pool` and the composition root's
 * dependency container, getting back the actual per-request `AdapterHandler` — the same `createX(pool)`
 * shape every other handler in this service already uses, plus the container for the routes that
 * need one. Factories that ignore the container declare only `pool`. `ModuleRegistry` resolves
 * `handlerExport` to `unknown` (it has no reason to know this service's HTTP types); this is the one
 * place that value is cast back to this shape.
 */
export type CustomRouteHandlerFactory = (pool: Pool, dependencies: CustomRouteDependencies) => AdapterHandler;

/** The empty container: what a caller mounts when no route it mounts needs a member. */
export function createCustomRouteDependencies(): CustomRouteDependencies {
  return {};
}

/**
 * Thrown when a route runs without a member the composition root did not configure. It is a plain
 * error, not a `ChokePointError`: the adapter logs it and answers a generic 500, so no domain status
 * is invented for a deployment that is missing configuration.
 */
export class CustomRouteConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomRouteConfigurationError";
  }
}

/**
 * Returns one member of the container, or throws `CustomRouteConfigurationError` naming it when the
 * composition root did not configure it. Call it inside the handler, once per request: a call made
 * while the factory runs would fail the whole mount at startup, for a route that may never be called.
 */
export function requireCustomRouteDependency<K extends keyof CustomRouteDependencies>(
  dependencies: CustomRouteDependencies,
  member: K,
): NonNullable<CustomRouteDependencies[K]> {
  return dependencies[member] ?? unconfiguredDependency(member);
}

function unconfiguredDependency(member: keyof CustomRouteDependencies): never {
  throw new CustomRouteConfigurationError(
    `custom route dependency "${member}" is not configured by the composition root`,
  );
}

/**
 * Resolves every active module's custom route (issue #239) into the `routeTable.ts` compiler
 * shared by every route family this adapter mounts — a custom route gets no private auth, error,
 * or path-matching logic of its own. Each factory receives the same `dependencies` object.
 */
export function mountCustomRoutes(
  pool: Pool,
  definitions: readonly ModuleCustomRouteDefinition[],
  dependencies: CustomRouteDependencies,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const routes: RouteDefinition[] = definitions.map((definition) => ({
    method: definition.method,
    path: definition.path,
    handler: (definition.handler as CustomRouteHandlerFactory)(pool, dependencies),
  }));
  return mountRoutes(pool, routes);
}
