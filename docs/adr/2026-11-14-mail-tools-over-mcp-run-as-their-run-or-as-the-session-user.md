---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Mail tools over MCP run as their run or as the session's user

## Context

[[2026-11-04-mcp-exposes-module-agent-tools]] exposes module tools on `POST /mcp` only to a restricted run credential,
and only those whose capability is a core capability id: a credential lists core ids alone, so a tool with a module's
own capability (`mail.read`, `mail.draft`, `mail.send`) is absent. It leaves a human session without module tools,
because a handler takes a persisted run and a human session has no run, and it assigns the actor-compatible contract
for the domain tools to the issues that expose them (gh-1956 for mail). [[2026-10-28-module-agent-tools-approval-and-grants]]
decides what that contract does: a run credential gets the classification and grants of an agent session, and a human
session acts with the user's permissions without approval, so a human session's mail send leaves without a request.
[[2026-11-14-the-mail-send-tool-is-declared-without-deferral-and-files-its-own-approval-request]] already makes a run
credential's call of `mail.draft.send` file the request and leaves the human session's send to this decision.
[[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]] marks the writer of a human `/mcp` session.

## Decision

1. **A module tool opts in to MCP.** The descriptor of an agent tool may declare `mcp: { humanHandlerExport }`. A tool
   that does not declare it keeps its present exposure: over MCP only a run credential sees it, and only when it has no
   capability or a core one. Only the four tools `mail.thread.get`, `mail.draft.create`, `mail.draft.update` and
   `mail.draft.send` declare it; `mail.thread.proposeTask` does not. A tool that declares it must have a capability and
   `approval: "none"` and no `requiresApproval`, which the manifest schema checks.
2. **A run credential's list is the upper bound for such a tool, and the project's grants are the other.** A tool is
   offered to a credential exactly when the credential's own list names the tool's capability and the run's project holds
   it (it owns the module's databases), the rule of an agent session intersected with the credential. The mint accepts,
   besides the core capability ids, the capability ids of the active modules (`POST /api/agent-runs/mcp-credentials` is
   given the module registry), so a user who mints a credential for a mail project chooses `mail.read`, `mail.draft`
   and `mail.send` one by one, and a list of core ids only exposes no module tool. The credential row stores them in
   its existing `capabilities text[]` column, so no migration is needed; a reader keeps the core ids it knows for the
   generic operations and passes the rest to the module tool resolver, which intersects them with the project's grants.
   The calls run as the credential's run in its project, so the handlers and the approval request of `mail.draft.send`
   are those of the session, and the request's source is `mcp` because the run was triggered by `mcp`. A project that
   does not hold the capability, or a credential that does not list it, does not list the tool, and a call of it is the
   "method not found" of an unknown name.
3. **A human session's tool runs as the user.** A human session has no run and no project, so no project grant is
   evaluated and no run is invented: the tool is offered when its module is active, which is when its capability is
   registered, and an inactive module's tool is absent and answers "method not found". The tool's `humanHandlerExport` is a
   factory `(pool, dependencies)` that returns `(userId, args)` with the result shape of the run handler; `dependencies` is
   the container the composition root builds for the custom routes of the same process
   ([[2026-10-29-custom-route-composition-root-dependencies]]), so the send tool has the transports of the send route. The
   arguments are validated with the schema of the run handler.
4. **Writes of a human session are attributed to an agent acting for the user.** The mail draft tools write as
   `writerKind: "agent"` with `onBehalfOfUserId` the session's user, no run and no project, and with the external-client
   marker of [[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]]. The marker is set by the user
   handlers of the mail module for the one caller that decision names, the human token branch of `/mcp`, because the
   tools write through the draft operations and not through the generic gateway that derives the writer from the actor.
   A draft such a session makes or edits records an agent as its author and no run. A run that no person asked for
   cannot be the session, so the guard that keeps a heartbeat's run from overwriting the user's edit does not apply to it.
5. **`mail.draft.send` of a human session sends as the user** through `sendMailDraft` (the send route's function) and
   creates no approval request. A run credential's call still only files the request of
   [[2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user]].

## Alternatives considered

- **A run made up for the human session.** Rejected by [[2026-11-04-mcp-exposes-module-agent-tools]]: no project grant is
  evaluated for a run that does not exist and no write is silently authorized.
- **A credential that cannot name a module capability, with the project's grants applying as they are.** Rejected after
  review: a restriction that cannot express a module capability is read as "allow", so a credential minted for
  `core.item.read` alone would list and call the mail tools of its project, write drafts and file send requests. The
  credential is the restricted bearer the mint documents, and it only ever narrows what is granted. This reverses the
  rejection of module capability ids in [[2026-11-04-mcp-exposes-module-agent-tools]] for the tools that declare `mcp`;
  it adds no grant provider, because the project's grants remain the other bound.
- **Exposing every module tool with approval `none` to a run credential.** Rejected: it widens the surface of every module
  at once and for no issue; each module opts in with its own issue.

## Consequences

- The credential of a mail project can create and update drafts, read threads and file the send request only for the
  `mail.*` capabilities it lists; a credential of another project cannot, whatever it lists. A credential minted before
  this decision lists core ids only and so exposes no mail tool, which is the closed default.
- A later module (the calendar tools of gh-1957) opts in the same way; a tool that needs a transport or another
  composition-root object reads it from `dependencies`.
- A human session needs `dependencies` to carry `mailServerClients.send` to send; without it the call fails with a plain
  error that the endpoint answers as an internal error, and the draft stays as it was.
- This extends [[2026-11-04-mcp-exposes-module-agent-tools]] for the tools that declare `mcp`; its text for every other tool
  stands.
