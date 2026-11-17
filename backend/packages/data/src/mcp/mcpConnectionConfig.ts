import { z } from "zod";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";

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

/** Valid identifiers excluding the SDK's inherited names, `LD_`/`DYLD_` prefixes and interpreter/shell hooks. */
const childEnvVarName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name")
  .refine((name) => !FORBIDDEN_ENV_NAMES.has(name), "is reserved for the child process environment")
  .refine((name) => !FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)), "uses a reserved prefix");

/** Discriminated by `transport`, the MCP specification's own term. */
const stdioConnectionConfig = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(childEnvVarName, z.string()).optional(),
  /**
   * The child env var the factory injects the decrypted credential under (a name, never a value). When absent the
   * factory injects nothing, even if a credential is stored.
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
 * A valid shape and, for `sse`/`http`, a URL passing the stored outbound URL baseline. The factory uses the
 * shape-only `assertValidMcpConnectionConfig`.
 */
export function assertStorableMcpConnectionConfig(value: unknown): McpConnectionConfig {
  let config: McpConnectionConfig;
  try {
    config = assertValidMcpConnectionConfig(value);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // The public error body drops non-primitive `details` (the zod `issues`), which would hide `field`.
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
