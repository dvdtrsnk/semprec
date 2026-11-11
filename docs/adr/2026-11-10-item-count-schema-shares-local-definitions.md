---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Share local definitions in the item.count input schema

## Context

`item.count` (issue #1709) takes up to twenty entries, and each entry may carry the finite filter tree of the shared generic query input. The default JSON Schema of that input expands the unrolled tree at every use. For `item.count` it is 37,127,114 bytes, larger than the 4 MiB agent request limit of [[2026-11-06-agent-images-use-bounded-ephemeral-payloads]]. [[2026-11-07-agent-query-schemas-share-local-definitions]] solved this for the agent's `database.query` and `view.query` tools only, with the definitions under `properties.filter`. It left every other operation's default schema unchanged, and the MCP `tools/list` schemas of [[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]] with them. `item.count` has no `filter` property at its root, and an agent derives the tool schema of every operation except those two from the default mode. Adding the operation without a decision makes the complete agent tool catalog exceed the request limit.

## Decision

`operationInputJsonSchema("item.count")` derives the Zod input schema with reusable local definitions, places them under `properties.items` and rewrites every generated local pointer to `#/properties/items/$defs/<name>`. This is the operation's only schema: the agent tool and MCP `tools/list` advertise the same one. The operation is new, so no schema a caller was already given changes.

The conversion is the one [[2026-11-07-agent-query-schemas-share-local-definitions]] introduced, with the property that holds the definitions as its parameter. It still rejects unsupported generated shapes, bases, references and cycles instead of emitting a partial schema. The `agent-query-compact` mode still accepts only `database.query` and `view.query`, and their default MCP schemas stay as they are. Zod validation of the input, grants and the payload limits are unchanged.

## Consequences

An MCP caller of `item.count` reads a schema whose references point below `properties.items`, not at root definitions. A later operation that carries the filter tree below its root needs the same treatment and names the property that holds its definitions.

Unit tests pin the schema, check that every reference is local and resolvable, validate real arguments against it with the pi validator and keep the complete agent catalog below the request limit. The local native-transport fixture observes the `item.count` tool schema next to those of the two query tools: one tool, definitions below `properties.items`, none at the root, every reference resolvable. As for those two, the fixture cannot prove acceptance by the live provider. Shrinking the default MCP schemas of the two query operations remains a separate decision.
