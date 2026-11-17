import type { PoolClient } from "pg";
import { z } from "zod";
import { eventDateIsInstant } from "../calendar/eventTime.js";
import { ValidationError } from "../errors.js";
import { normalizeMcpServerProperties } from "../mcp/mcpServerProposal.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import { buildEditorValues, normalizeHiddenFields } from "./editorSchema.js";
import { readProposalTimezone } from "./proposalComputedUpdates.js";
import { destinationOwnerModuleId, loadCardEditorRules, type EditorSchemaSource } from "./proposalEditorRules.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { parseUserOverrides } from "./proposalOverrides.js";

// Confirm writes what the card's editor shows: hidden fields are left out, and an MCP server card is written as the
// connection it declares.

const stdioConnectionSchema = z.object({ transport: z.literal("stdio") });

/**
 * Refuses an MCP server card with a `stdio` connection (`ValidationError` on `transport`), before envelope validation
 * so the answer names the transport. The model cannot author host commands, but a card from another writer may hold
 * one.
 */
export async function assertCardIsNotStdioMcpServer(client: PoolClient, envelope: ProposalEnvelope): Promise<void> {
  if (envelope.entityKind !== "database") return;
  if (!stdioConnectionSchema.safeParse(envelope.properties.connectionConfig).success) return;
  if ((await destinationOwnerModuleId(client, envelope)) !== MCP_SERVERS_MODULE_ID) return;
  throw new ValidationError("A stdio MCP server cannot be created from a proposal", { field: "transport" });
}

function normalizePrimary(
  envelope: ProposalEnvelope,
  normalize: (properties: Record<string, unknown>) => Record<string, unknown>,
): ProposalEnvelope {
  return {
    ...envelope,
    properties: normalize(envelope.properties),
    ...(envelope.operations
      ? {
          operations: envelope.operations.map((step) =>
            step.role === "primary" ? { ...step, properties: normalize(step.properties ?? {}) } : step,
          ),
        }
      : {}),
  };
}

/**
 * The envelope a confirm writes for a `database` envelope: the primary step's properties without fields the editor
 * schema hides (all-day dates lose their time, in the tenant zone), and an MCP server card's connection normalized.
 * Other kinds, and cards without an editor schema that are not MCP servers, return unchanged. An MCP server card is
 * judged by its destination since no module maps it to a card kind. Secondary steps are not normalized.
 */
export async function normalizeEnvelopeForWrite(
  client: PoolClient,
  proposal: { id: string; properties: Record<string, unknown> },
  envelope: ProposalEnvelope,
  targetDatabase: DatabaseRow | null,
  registry?: EditorSchemaSource,
): Promise<ProposalEnvelope> {
  if (envelope.entityKind !== "database") return envelope;
  if (targetDatabase?.ownerModuleId === MCP_SERVERS_MODULE_ID) {
    return normalizePrimary(envelope, normalizeMcpServerProperties);
  }
  const rules = await loadCardEditorRules(client, proposal.properties.kind, envelope, registry);
  if (!rules) return envelope;
  const values = buildEditorValues(envelope, parseUserOverrides(proposal.properties.userOverrides, proposal.id));
  const hiddenTimeIsNull = targetDatabase?.ownerModuleId === EVENTS_MODULE_ID;
  // Read the tenant zone only when a time-hiding date field carries an instant, the one value converted in the zone.
  const timeFieldKeys = rules.schema.groups
    .flatMap((group) => group.fields)
    .filter((field) => field.timeHiddenWhen !== undefined)
    .map((field) => field.key);
  const primaryProperties = [
    envelope.properties,
    ...(envelope.operations ?? []).map((step) => (step.role === "primary" ? (step.properties ?? {}) : {})),
  ];
  const carriesInstant = primaryProperties.some((properties) =>
    timeFieldKeys.some((key) => eventDateIsInstant(properties[key])),
  );
  const zone = carriesInstant ? await readProposalTimezone(client) : undefined;
  return normalizePrimary(envelope, (properties) =>
    normalizeHiddenFields(rules.schema, values, properties, rules.destinationKeys, hiddenTimeIsNull, zone),
  );
}
