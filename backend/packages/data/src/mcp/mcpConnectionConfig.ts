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
