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

/**
 * What confirm writes is what the card's editor shows (issue #1934): the properties of fields the editor schema
 * hides are left out of the created item, and an MCP server card is written as the connection it declares. Split out
 * of `proposalActions.ts` to keep that file under the ESLint line cap.
 */

/** A stored `connectionConfig` whose transport is `stdio`. */
const stdioConnectionSchema = z.object({ transport: z.literal("stdio") });

/**
 * Refuses an MCP server card whose connection is `stdio` with a `ValidationError` on `transport`, before the
 * envelope validation, so that the answer names the card's transport and not the stored `connectionConfig`. A
 * model-authored host command never becomes a card, but a card stored before that rule, or by another writer, may
 * hold one (`docs/adr/2026-10-16-stdio-mcp-confined-to-admin-tenants.md`). Any other card, an envelope that is not a
 * database one and an envelope for another destination pass: a `connectionConfig` on another destination is the
 * unknown property that the envelope validation refuses.
 */
export async function assertCardIsNotStdioMcpServer(client: PoolClient, envelope: ProposalEnvelope): Promise<void> {
  if (envelope.entityKind !== "database") return;
  if (!stdioConnectionSchema.safeParse(envelope.properties.connectionConfig).success) return;
  if ((await destinationOwnerModuleId(client, envelope)) !== MCP_SERVERS_MODULE_ID) return;
  throw new ValidationError("A stdio MCP server cannot be created from a proposal", { field: "transport" });
}

/** The envelope with `normalize` applied to the properties of its primary step: the top-level ones, which mirror that step, and the step's own. */
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
 * The envelope a confirm writes, for a `database` envelope: the properties of the primary step without the fields
 * the card's editor schema hides for its effective values (`normalizeHiddenFields`, which also takes the time of
 * day off the date of an all-day card, in the tenant zone when it is an instant), and an MCP server card's
 * connection as `normalizeMcpServerProperties` stores it. `targetDatabase` is the envelope's target as the envelope
 * validation resolved it. A card of another entity kind, and a card with no editor schema (`loadCardEditorRules`)
 * that is not an MCP server, come back as they are. An MCP server card is judged by its destination, not by its
 * schema: no module maps that destination to a card kind yet, so its editor schema is not applied
 * (`deriveInboxCardKind`). A secondary step is not normalized. Call it after the required-field check and before
 * any destination write; `registry` is as in `loadCardEditorRules`.
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
  // The tenant zone is read, as every proposal preparation reads it, only when a date field that can hide its time
  // carries an instant, which is the one value that is converted in the zone.
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
