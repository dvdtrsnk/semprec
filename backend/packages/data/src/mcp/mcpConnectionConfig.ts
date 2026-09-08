import { z } from "zod";
import { ValidationError } from "../errors.js";

/**
 * Strict, transport-discriminated shape for `mcpServers.connectionConfig` (issue #123).
 * `transport` (not `kind`) as the discriminator: this mirrors the MCP specification's own
 * vocabulary for these three connection kinds, unlike the `kind`-discriminated rule shapes
 * elsewhere in this package (scheduler/rule.ts, tasks/taskRecurrenceRule.ts), which name an
 * unrelated concept (a schedule's recurrence kind).
 */
const stdioConnectionConfig = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Names the child process env var the connection factory (issue #231) should inject the
   * server's decrypted `external_credentials` secret under, e.g. `"API_KEY"` — declares only
   * a variable *name*, never a value, so it carries nothing `mcpServerProposal.ts`'s
   * credential-shaped-field denylist needs to reject. Omit when the server takes no
   * credential; the factory injects nothing when this is absent even if a credential happens
   * to be stored.
   */
  credentialEnvVar: z.string().min(1).optional(),
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
