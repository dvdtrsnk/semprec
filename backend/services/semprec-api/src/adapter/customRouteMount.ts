import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type {
  CalDavVerification,
  HeartbeatRuleKindRegistry,
  MailContentProviders,
  MailSendAdapterFactory,
  VerifiedMailServerSettings,
  VerifyCalDavServerInput,
  VerifyMailCredentialsInput,
} from "@semprec/data";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import type { AiGatewayClientPort } from "@semprec/shared";
import type { ClientIpThrottle } from "../clientIpThrottle.js";
import { mountRoutes, type RouteDefinition } from "./routeTable.js";
import type { AdapterHandler } from "./adapterRoute.js";

export interface CustomRouteOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Every member is absent when the composition root did not configure it. */
export interface CustomRouteOAuthConfig {
  gmail?: CustomRouteOAuthClient;
  msGraph?: CustomRouteOAuthClient;
  /** The composition root's `APP_BASE_URL`. */
  redirectBaseUrl?: string;
}

export interface MailServerClients {
  /**
   * Resolves with the IMAP and SMTP endpoints that accepted the login, and the folders listed on the
   * verified IMAP connection when asked for; rejects when no endpoint did. Runs before any mailbox is
   * stored. A mount without it fails each request of the password routes with a configuration error.
   */
  verifyPassword?: (input: VerifyMailCredentialsInput) => Promise<VerifiedMailServerSettings>;
  /**
   * Resolves when the login finds a calendar home at the CalDAV address, with the server a
   * well-known address delegated the account to. The password connect route calls it only for a
   * body with `caldavUrl`; a mount without it fails such a request with a configuration error.
   */
  verifyCalDav?: (input: VerifyCalDavServerInput) => Promise<CalDavVerification>;
  /**
   * `createDispatcher` builds them from `oauth`, `outboundHttp` and its blob storage when the
   * container carries none.
   */
  send?: MailSendAdapterFactory;
}

export interface MailLiveSyncControl {
  startMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
  stopMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
  /** A reauthorization calls it after its commit. */
  restartAccount(mailboxItemId: string): Promise<void>;
}

/**
 * Every member is optional. A route reads its member through `requireCustomRouteDependency` when it
 * runs, so a route that does not use a member never notices it is absent.
 */
export interface CustomRouteDependencies {
  heartbeatRuleKinds?: () => Promise<HeartbeatRuleKindRegistry>;
  oauth?: CustomRouteOAuthConfig;
  mailServerClients?: MailServerClients;
  mailLiveSync?: MailLiveSyncControl;
  /**
   * The provider clients and attachment storage of the on-demand message content and attachment save routes.
   * `createDispatcher` builds them from `oauth`, `outboundHttp` and its mail attachment storage when the container
   * carries none.
   */
  mailContent?: MailContentProviders;
  outboundHttp?: typeof fetch;
  /** A mount without it fails each request of a route that needs it with a configuration error. */
  aiGateway?: AiGatewayClientPort;
  /**
   * Counts each user's login verifications in the password routes and provider fetches of the
   * on-demand mail content routes. `createDispatcher` creates one when the container carries none.
   */
  throttle?: ClientIpThrottle;
  /**
   * `MAX_FILE_SIZE_MB` in bytes: the draft attachment limit of a mailbox with no provider limit,
   * the one `POST /api/files` enforces.
   */
  maxFileSizeBytes?: number;
}

/**
 * What every module custom route's `handlerExport` must resolve to: a factory the mount calls once
 * at startup, returning the per-request `AdapterHandler`. `ModuleRegistry` resolves `handlerExport`
 * to `unknown`; this is the one place that value is cast back to this shape.
 */
export type CustomRouteHandlerFactory = (pool: Pool, dependencies: CustomRouteDependencies) => AdapterHandler;

export function createCustomRouteDependencies(): CustomRouteDependencies {
  return {};
}

/**
 * A plain error, not a `ChokePointError`: the adapter logs it and answers a generic 500, so no
 * domain status is invented for missing deployment configuration.
 */
export class CustomRouteConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomRouteConfigurationError";
  }
}

/**
 * Call it inside the handler, once per request: a call while the factory runs would fail the whole
 * mount at startup, for a route that may never be called.
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
 * Custom routes compile into the same `routeTable.ts` table as every other route family, with no
 * auth, error or path-matching logic of their own. Each factory receives the same `dependencies`
 * object.
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
    ...(definition.maxBodyBytes !== undefined ? { maxBodyBytes: definition.maxBodyBytes } : {}),
  }));
  return mountRoutes(pool, routes);
}
