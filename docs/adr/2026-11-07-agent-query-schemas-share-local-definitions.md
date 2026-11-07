---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# Share local definitions in agent query schemas

## Context

The finite filter tree in the shared generic query input is unrolled to bound nesting. Its default JSON Schema expands repeated subtrees, making each query tool larger than the whole request limit in [[2026-11-06-agent-images-use-bounded-ephemeral-payloads]]. The same generator serves MCP tools/list under [[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]. Changing its default would also change that transport's advertised schemas.

## Decision

For agent `database.query` and `view.query` only, derive the same Zod input schema with reusable local definitions. Place those definitions under the existing `properties.filter` schema and rewrite generated local pointers to that location. The pinned native Anthropic adapter's non-strict projection preserves properties but drops root definitions. Reject unsupported generated shapes, bases, references and cycles instead of emitting a partial schema. The MCP and other operation defaults stay unchanged. Existing authoritative Zod validation, grants, approval behavior and payload limits remain in force.

## Consequences

Agent query schemas carry a bounded shared representation instead of repeatedly expanded finite branches. This adds a representation-specific conversion and requires actual pi validator and native transport checks. The local transport fixture can observe the emitted schema but cannot prove acceptance by the live provider. We do not enable provider strict mode, change the SDK, remove tools or increase the request cap. Other model failures and their causes require separate evidence.
