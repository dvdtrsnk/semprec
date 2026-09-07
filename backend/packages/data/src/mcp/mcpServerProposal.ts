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
const MCP_CREDENTIAL_FIELD_NAMES: readonly string[] = [
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
    assertValidMcpConnectionConfig(properties.connectionConfig);
  }
}
