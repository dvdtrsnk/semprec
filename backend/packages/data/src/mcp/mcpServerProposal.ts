import { ValidationError } from "../errors.js";
import { assertValidMcpConnectionConfig } from "./mcpConnectionConfig.js";

/**
 * Names a proposal for an `mcpServers` item (issue #123) could plausibly carry a secret
 * under — checked independently of `mcpServers`'s actual declared properties (which never
 * include any of these), so a future accidental `owner: 'user'` property with one of these
 * keys is still rejected here rather than relying solely on ownership. The credential itself
 * never lives in `items.properties` at all — it goes into `external_credentials` (issue #26),
 * supplied by a human separately at confirm time (proposalActions.ts), never inside the
 * envelope an agent computes.
 */
export const MCP_CREDENTIAL_FIELD_NAMES: readonly string[] = [
  "credential",
  "credentialType",
  "plaintext",
  "apiKey",
  "token",
  "bearerToken",
  "refreshToken",
  "secret",
  "password",
];

/** Lowercases and strips `_`/`-` so `apiKey`, `API_KEY`, and `api-key` all normalize the same way. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

const NORMALIZED_CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set(MCP_CREDENTIAL_FIELD_NAMES.map(normalizeFieldName));

/**
 * A `stdio` transport's `env` map is itself a plausible smuggling route for a secret an agent
 * isn't allowed to set (e.g. `env: { apiKey: "sk-..." }` or `env: { API_KEY: "sk-..." }`) — it
 * never appears as a top-level proposal property, so the loop below wouldn't otherwise catch
 * it. Checked against the same denylist, normalized (env vars are conventionally
 * `SCREAMING_SNAKE_CASE`, not camelCase) rather than exact-matched.
 */
function assertNoCredentialShapedEnvKeys(connectionConfig: unknown): void {
  if (typeof connectionConfig !== "object" || connectionConfig === null) return;
  const env = (connectionConfig as { env?: unknown }).env;
  if (typeof env !== "object" || env === null) return;
  for (const key of Object.keys(env)) {
    if (NORMALIZED_CREDENTIAL_FIELD_NAMES.has(normalizeFieldName(key))) {
      throw new ValidationError(`Proposal properties for an MCP server cannot carry credential field '${key}' in connectionConfig.env`, { field: key });
    }
  }
}

/**
 * Extra validation `assertValidProposalEnvelope` (inboxTickAction.ts) runs for a `database`
 * envelope whose target is the `mcpServers` system database, on top of the generic
 * unknown-key/relation/rollup/system-owner checks it already applies to every target: reject
 * any credential-shaped field outright, and strictly validate `connectionConfig` against the
 * transport-discriminated schema when present. Semp may still propose a bare `name` with no
 * `connectionConfig` at all (e.g. leaving it for the confirming human to fill in), so
 * `connectionConfig` is validated only when the envelope actually sets it, not required here.
 */
export function assertValidMcpServerProposalProperties(properties: Record<string, unknown>): void {
  for (const field of MCP_CREDENTIAL_FIELD_NAMES) {
    if (field in properties) {
      throw new ValidationError(`Proposal properties for an MCP server cannot carry credential field '${field}'`, { field });
    }
  }
  if ("connectionConfig" in properties) {
    assertNoCredentialShapedEnvKeys(properties.connectionConfig);
    assertValidMcpConnectionConfig(properties.connectionConfig);
  }
}
