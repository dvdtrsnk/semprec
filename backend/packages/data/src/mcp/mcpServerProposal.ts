import { ValidationError } from "../errors.js";
import { assertStorableMcpConnectionConfig, mcpConnectionConfigSchema } from "./mcpConnectionConfig.js";

/**
 * Checked independently of the declared properties, so a future `owner: 'user'` property with such a key is still
 * rejected. The credential itself never lives in `items.properties`: a human supplies it into
 * `external_credentials` at confirm time, never inside an agent's envelope.
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

const NORMALIZED_CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set(
  MCP_CREDENTIAL_FIELD_NAMES.map(normalizeFieldName),
);

/**
 * A `stdio` `env` map is a smuggling route the top-level check would miss; matched normalized, since env vars are
 * `SCREAMING_SNAKE_CASE`.
 */
function assertNoCredentialShapedEnvKeys(connectionConfig: unknown): void {
  if (typeof connectionConfig !== "object" || connectionConfig === null) return;
  const env = (connectionConfig as { env?: unknown }).env;
  if (typeof env !== "object" || env === null) return;
  for (const key of Object.keys(env)) {
    if (NORMALIZED_CREDENTIAL_FIELD_NAMES.has(normalizeFieldName(key))) {
      throw new ValidationError(
        `Proposal properties for an MCP server cannot carry credential field '${key}' in connectionConfig.env`,
        { field: key },
      );
    }
  }
}

/**
 * A query string like `?token=sk-...` passes both the key denylist and the schema. `url` may not parse yet (the
 * schema check runs after this); then there is nothing to inspect.
 */
function assertNoCredentialShapedUrlParams(connectionConfig: unknown): void {
  if (typeof connectionConfig !== "object" || connectionConfig === null) return;
  const url = (connectionConfig as { url?: unknown }).url;
  if (typeof url !== "string") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  for (const key of parsed.searchParams.keys()) {
    if (NORMALIZED_CREDENTIAL_FIELD_NAMES.has(normalizeFieldName(key))) {
      throw new ValidationError(
        `Proposal properties for an MCP server cannot carry credential field '${key}' in connectionConfig.url`,
        { field: key },
      );
    }
  }
}

function assertNotStdioConfig(connectionConfig: unknown): void {
  if (typeof connectionConfig !== "object" || connectionConfig === null) return;
  if ((connectionConfig as { transport?: unknown }).transport === "stdio") {
    throw new ValidationError("A stdio MCP server can only be configured by an administrator", {
      field: "connectionConfig",
    });
  }
}

/**
 * Extra checks for a `database` envelope targeting `mcpServers`, on top of the generic ones. `connectionConfig` is
 * validated only when set: Semp may propose a bare `name` for the human to complete.
 */
export function assertValidMcpServerProposalProperties(properties: Record<string, unknown>): void {
  for (const field of MCP_CREDENTIAL_FIELD_NAMES) {
    if (field in properties) {
      throw new ValidationError(`Proposal properties for an MCP server cannot carry credential field '${field}'`, {
        field,
      });
    }
  }
  if ("connectionConfig" in properties) {
    // A model-authored host command never becomes a card: stdio is confined to a human admin.
    assertNotStdioConfig(properties.connectionConfig);
    assertNoCredentialShapedEnvKeys(properties.connectionConfig);
    assertNoCredentialShapedUrlParams(properties.connectionConfig);
    assertStorableMcpConnectionConfig(properties.connectionConfig);
  }
}

/**
 * A remote connection is stored as `{ transport, url }` only, dropping fields the transport hides (a `command`).
 * `stdio`, no connection, and unparseable connections pass through: confirm refuses `stdio` earlier and envelope
 * validation judges the rest.
 */
export function normalizeMcpServerProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const connection = mcpConnectionConfigSchema.safeParse(properties.connectionConfig);
  if (!connection.success || connection.data.transport === "stdio") return properties;
  const { transport, url } = connection.data;
  return { ...properties, connectionConfig: { transport, url } };
}
