---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Select options of a schema-locked database change through two option operations

## Context

A system database is schema-locked (`databases.schema_locked`) by the seed
that creates it, once its schema is in place: `seedTenDatabases.ts` locks the
ten core databases and the module seeds lock theirs. From then on
`assertDatabaseSchemaUnlocked` in
`backend/packages/data/src/chokePoint/propertiesStore.ts` refuses to create a
property in such a database, to change a property's `config` or type and to
delete a property, each with `SchemaLockedError` (`schema_locked`, HTTP 403):
the schema of a locked database changes only by a code-level migration. A
property's display name stays writable. The rule lives in that function and
its error; no earlier ADR recorded it.

The options of a `select` or `multi_select` property are part of its `config`
(`config.options`, each `{ key, label?, color? }`; gh-1584 added the color).
The one catalog operation that changes them after the property was created
is `property.patch`, which replaces the whole array and is refused on a
locked database. A person therefore cannot give Health records a new tag;
gh-1700 had to ship two tags through a tenant cutover. Where the write is
allowed, replacing the whole array also loses an option that another client
added between this client's read and its write.

Operations that clients, MCP and agents call are in the closed generic
operation catalog, and
[[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]
decided "one dispatch path, three transports": REST, MCP and AgentTool reach
the same operations. Under
[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] a
non-destructive catalog operation runs at once for an agent actor. A
non-destructive operation that adds an option would therefore be a tool the
assistant can call without a person, also on a system database, where no
tool can change the options of a property today. gh-1699 decides that a
person approves a new option, in line with
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]].

## Decision

### 1. The exception to the lock

Two operations may change `config.options` of a `select` or `multi_select`
property of a schema-locked database (gh-1699):

- `property.option.add` appends one option.
- `property.option.update` writes the label, the color or both of one option.

They skip the `schema_locked` check and nothing else. The property must
exist, must not itself be `locked` (`PropertyLockedError`), and the config
they write passes the same `assertValidPropertyConfig` every config write
passes, which is where an option's color is validated and stored in upper
case.

Every other schema change of a locked database stays forbidden and still
answers `SchemaLockedError`: creating, retyping and deleting a property, and
`property.patch` of a `config`, the option array included. No operation
removes an option of a locked database, reorders its options or changes an
option key.

Why these two and no others: neither removes a key nor changes one, so every
stored item value and every stored filter stays valid afterwards. That does
not hold for any other schema change.

### 2. The key

The server derives the key of a new option from its label; the caller cannot
choose it. Why: the key is stored in item values and filters and never
changes afterwards, so one derivation in one place keeps it predictable and
free of collisions.

The label is normalized to Unicode NFKD and its combining marks are removed.
Every remaining character outside `A-Z`, `a-z` and `0-9` separates words. The
first word is written in lower case, each later word with an upper-case first
letter and the rest in lower case, and the words are joined: "Dentální
hygiena" gives `dentalniHygiena`. When no word remains the key is `option`.
When the property already holds the key, the lowest free integer from 2 up is
appended (`bylinky2`).

Such a key is ASCII camelCase, but it is English only when the label is.
[[2026-09-10-english-canonical-keys-with-i18n-labels]] governs the keys that
code, seeds and migrations introduce, and it is unchanged: a shipped option
still gets an English key and its two catalog entries. An option added at
runtime is user content. No catalog names it, and its stored `label` is the
override that the label fallback chain of that ADR reads first.

### 3. The label

The label is stored without surrounding whitespace and has 1 to 60 UTF-16
code units; anything else is refused with 400 `validation_failed` naming
`label`. A label that holds U+0000 or a UTF-16 surrogate without its pair
(what cutting a text in the middle of an emoji leaves) is refused the same
way. Why: the options are stored in a `jsonb` column, which can hold neither,
so the write would fail in the database and the caller would get a 500.

A label that another option of the same property already has is refused with
409 and the new error code `option_label_exists`, whose `details.key` is that
option's key. The labels of an option that are compared are its stored
`label` and the Czech and the English catalog entry `property.<database
key>.<property key>.option.<option key>` of the module that owns the
database; the catalog entries are compared also when a stored label overrides
them in what a client displays. Two labels are equal when they match after
Unicode NFD normalization, removal of combining marks, removal of surrounding
whitespace and conversion to lower case: "léky" equals the "Medication"
option of Health records, whose Czech entry is "Léky". On a rename the
renamed option is not compared with itself. An option with neither a stored
label nor a catalog entry is displayed by its raw key, the last step of the
label fallback chain; the raw key is not compared, so such an option is never
a match. Why: two options a person cannot tell apart are a mistake to
prevent, and the caller gets the existing key so that it can use that option
instead.

The catalogs are read from a module registry that `loadFullModuleRegistry`
builds once per process inside the data package, because the choke point is
constructed from a pool alone and holds no registry of a composition root.

### 4. The limit

An add to a property that already holds 100 or more options is refused with
400 `validation_failed` (`reason: "option_limit"`). An update is not limited.

### 5. The lock

Each operation runs in one `withTransaction` at READ COMMITTED. It reads the
property row with `SELECT ... FOR UPDATE`, runs every check above on that
row, and writes the whole `config` back with one `UPDATE`. A second option
write on the same property waits at the row lock until the first one commits
and then reads the committed options. Two concurrent adds therefore both end
up stored, and of two concurrent adds of one label the later one is refused.
`property.patch` takes the same row lock before it writes a `config`. No
isolation level is raised and nothing is retried.

### 6. After the write

In the same transaction the operation queues the search reindex that every
property write queues for its database (gh-1652), because search documents
contain option labels. After the commit it sends the schema invalidation of
the database through `runAfterCommit`
([[2026-09-10-side-effects-follow-the-commit]]).

### 7. Transports

Both operations are in the catalog with the capability `core.schema.write`
and non-destructive metadata. REST serves them as
`POST /api/properties/:id/options` (201) and
`PATCH /api/properties/:id/options/:key`; both answer with the option as
`{ key, label, color? }`, resolved as the schema projection resolves it for
the caller: `label` is the stored label or, for an option without one, its
catalog label in the caller's locale.

The `:key` segment of the update route is the option key percent-encoded as
a URL path segment. The handler decodes it once before the lookup, and a
segment that is not valid percent-encoding of UTF-8 is refused with 400
`validation_failed` naming `key`. Why: a stored option key is any non-empty
string. A key derived as in section 2 consists of ASCII letters and digits,
but a key written through `property.create` or `property.patch`, or kept
from a legacy option string by migration `0029_select_option_keys.sql`, can
hold a space, a non-ASCII letter or a `/`, and the route table hands a
handler each path segment undecoded. Only this parameter is decoded; the
path parameters of every other route stay as they were.

They are listed in `REST_ONLY_OPERATION_NAMES`
(`backend/packages/shared/src/genericOperations/operationNames.ts`). They
are not REST-only extension methods in the sense of
[[2026-10-01-rest-only-port-extension-methods]], which covers port methods
outside the catalog: both are catalog operations with their own input
schemas, and REST dispatches them through `dispatchGenericOperation`.
`GenericOperationGateway`, through which the AgentTool and MCP transports
list and call catalog operations, lists a REST-only operation under no grant
and refuses a call to it with the same not-found answer an operation outside
the caller's grant gets. This narrows "one dispatch path, three transports" of
[[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]: a
REST-only operation has one transport. Why: a change of the schema is to be
approved by a person. The assistant will propose a new option on an Inbox
proposal, and the option will be created when a person confirms that
proposal (gh-1994).

## Consequences

- The options of a system select are no longer only what code wrote; they
  can differ between tenants. A migration or cutover that rewrites
  `config.options` of a system property has to keep the options and option
  fields it does not name, as `healthRecordTagsCutoverMigration.ts`,
  `selectOptionOrderCutoverMigration.ts` and
  `selectOptionColorsCutoverMigration.ts` do, and has to expect that a key it
  wants to add is already stored.
- An option added to a locked database cannot be removed there; a rename is
  the only correction. Removing one needs its own decision.
- `option_label_exists` joins the REST error contract as an additive code
  ([[2026-09-11-additive-only-rest-contract-no-url-versioning]]).
- A later catalog operation that must not become an agent or MCP tool joins
  `REST_ONLY_OPERATION_NAMES` with its own recorded reason. The contract
  tests of both transports expect every operation of that list to be refused.
- The label check reads the catalogs of the data package's own registry
  instance. A registry that a test or a composition root builds differently
  does not change what the check compares.
