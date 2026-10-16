import { z } from "zod";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";

/**
 * Strict, transport-discriminated shape for `mcpServers.connectionConfig` (issue #123).
 * `transport` (not `kind`) as the discriminator: this mirrors the MCP specification's own
 * vocabulary for these three connection kinds, unlike the `kind`-discriminated rule shapes
 * elsewhere in this package (scheduler/rule.ts, tasks/taskRecurrenceRule.ts), which name an
 * unrelated concept (a schedule's recurrence kind).
 */
/**
 * Names a child process environment variable may take (issue #1033). Besides the shape, a name
 * must not be one the factory's child inherits from the parent (`getDefaultEnvironment`), must not
 * start with a dynamic-loader prefix, and must not be a known interpreter or shell start-up hook:
 * any of those lets a stored config change how the child runs rather than what it is given.
 */
const INHERITED_ENV_NAMES = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
const FORBIDDEN_ENV_NAMES = new Set([
  ...INHERITED_ENV_NAMES,
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "GCONV_PATH",
]);
const FORBIDDEN_ENV_PREFIXES = ["LD_", "DYLD_"];

const childEnvVarName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name")
  .refine((name) => !FORBIDDEN_ENV_NAMES.has(name), "is reserved for the child process environment")
  .refine((name) => !FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)), "uses a reserved prefix");

const stdioConnectionConfig = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(childEnvVarName, z.string()).optional(),
  /**
   * Names the child process env var the connection factory (issue #231) should inject the
   * server's decrypted `external_credentials` secret under, e.g. `"API_KEY"` — declares only
   * a variable *name*, never a value, so it carries nothing `mcpServerProposal.ts`'s
   * credential-shaped-field denylist needs to reject. Omit when the server takes no
   * credential; the factory injects nothing when this is absent even if a credential happens
   * to be stored.
   */
  credentialEnvVar: childEnvVarName.optional(),
});

const sseConnectionConfig = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
});

const httpConnectionConfig = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
});

export const mcpConnectionConfigSchema = z.discriminatedUnion("transport", [
  stdioConnectionConfig,
  sseConnectionConfig,
  httpConnectionConfig,
]);

export type McpConnectionConfig = z.infer<typeof mcpConnectionConfigSchema>;

/** Throws `ValidationError` when `value` isn't a valid `stdio`/`sse`/`http` connection config. */
export function assertValidMcpConnectionConfig(value: unknown): McpConnectionConfig {
  const result = mcpConnectionConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid MCP server connectionConfig: ${result.error.message}`, {
      field: "connectionConfig",
      issues: result.error.issues,
    });
  }
  return result.data;
}

/**
 * What may be stored: a valid shape, and for `sse`/`http` a remote URL that passes the stored
 * outbound URL baseline (docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md).
 * `assertValidMcpConnectionConfig` stays shape-only for the connection factory.
 */
export function assertStorableMcpConnectionConfig(value: unknown): McpConnectionConfig {
  let config: McpConnectionConfig;
  try {
    config = assertValidMcpConnectionConfig(value);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // The public error body drops `details` holding non-primitive values (the zod `issues`), which
    // would hide `field`; keep the message and expose `field` alone.
    throw new ValidationError(err.message, { field: "connectionConfig" });
  }
  if (config.transport !== "stdio" && !isBaselineOutboundUrl(config.url)) {
    throw new ValidationError(
      "MCP server connectionConfig 'url' must be an https URL to a public DNS host, without credentials or a port",
      {
        field: "connectionConfig",
      },
    );
  }
  return config;
}
