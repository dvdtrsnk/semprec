---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A thread inherits its company and project through resolver link rules

## Context

A mail thread has a company and a project (`Threads.company`, `Threads.project`, issue #1573). Issue gh-1869 makes
them inherited: the company comes from the sender of the thread, the project from the company, and a user or Semp who
writes the value ends the inheritance.

The link engine of [[2026-11-05-value-link-propagation-keeps-separate-hop-budgets]] copies a value of a source item to
a target item along one relation (`source`, `target` and `via` of a rule descriptor). Neither value of a thread has
such a source: the company is found by matching the domain of an address against `Companies.web`, among the companies
of the person who owns the address or, for an address nobody owns, among all companies; the project is the one active
project of the company. The value is computed, and the items it depends on (a person, a company, a project, the first
inbound message of the thread) are not connected to the thread by one relation.

The alternatives were a mail job that writes both values itself, which would be a second writer next to the engine
with its own handling of an own value, an ended link, relink, hop budgets and approval, and a relation between the
thread and each of its inputs, which would only mirror what the sender already says. The `value_links` and
`value_link_sources` tables already hold what the sender case needs: a source of kind `senderDomain`, with a domain and
no item, was created by the migration of issue #1403.

## Decision

A link rule of a module manifest may name a resolver instead of a source and a via
(`ModuleResolverLinkRuleDescriptor`: `key`, `target`, `resolverExport`). `resolverExport` names an object export of the
module file. The object (`LinkRuleResolver`, `valueLinks/linkResolver.ts`) declares:

- `inputs`: the relation properties whose edge change and the plain properties whose update make an answer stale;
- `resolve(client, itemId)`: the ids the target relation of the item should hold and the sources of the link;
- `affectedItemIds(client, changedItemId, afterId, limit)`: the items of the rule's target database that a change of
  `changedItemId` may have changed, in ascending id order.

The registry checks that the export exists and is an object; the engine parses the rest where it enters
(`parseLinkRuleResolver`), so a resolver that returns anything but ids and sources fails the job. A resolver rule adds
no edge to the property graph that rejects cycles; the project rule depends on the company rule only through the
company edge it triggers on, and nothing triggers the company rule from `Threads.project`.

The two rules of the Mail module (`mail/threadLinkRules.ts`, declared in `mail/mailModuleManifest.ts`):

- `threadCompanyFromSender`, target `Threads.company`. The sender is the author of the thread's first inbound message:
  of the live copies that are none of the tenant's own mail and are in no Sent and no Drafts folder, the earliest by
  activity, then by item id. A freemail domain, no sender or no match gives no company. A sender in
  `person_email_index` gives the one company of the person's `People.companies` whose web host equals the sender's
  domain or has it as a subdomain (`www.` ignored, case ignored); the source is the person, property `companies`. An
  unknown sender gives the one company of the tenant that matches; the source is the sender domain, kind
  `senderDomain`, property `web`. Several matching companies give none.
- `threadProjectFromCompany`, target `Threads.project`. For a thread with exactly one company, entered by the user or
  inherited, the one project of the company's `Companies.projects` with status `inProgress` or `longTerm`; the source is
  the company, property `projects`. No company, no active project and several give none.

Triggers. The hooks of the engine (`linkRuleEdgeHook`, `linkRuleItemHook`) queue the `valueLinksPropagate` job of a
resolver rule, with the changed item as `sourceItemId`, for a created or deleted edge of a declared relation property
(`People.companies`, `Companies.projects`, `Threads.company`) and for an update that patches a declared plain property
(`Companies.web`, `Projects.status`), and for the creation or the restore from the trash of an item that holds a
property declared `onAppear` (`Companies.web`; a created project has no company yet, its edge is an input of its own)
(`linkRuleItemCreateHook`, `linkRuleItemRestoreHook`). The job asks the resolver for the affected items and evaluates each one, a hundred
to a committed transaction. After the ingest of a message that is now the first inbound message of its thread, the
rules are queued for the thread's item through `enqueueLinkPropagation` at the budget of a root write. The queue and the
hop budgets are those of the engine; a write the evaluation makes carries its hop, so the company edge it writes queues
the project rule one hop further.

Evaluation of one item (`evaluateResolverRule`), under the item's row lock and then its link row's:

- a link that is `broken`, or belongs to another rule, leaves the item alone;
- without a link, a value the item already holds is its own and gets no link; an empty resolution writes nothing;
  otherwise the link is created `on`, with the resolver's sources, before the value is written;
- with an `on` link, the sources become the resolver's and the value its values; an empty resolution removes the value,
  while the link is still `on`, and then the link.

Relink of a link of a resolver rule runs the resolver again: the sources and the value become its answer, and the link
is `on`. A resolver with no value for the item, for a sender-domain source that no company has the domain in its web
address any more, answers `409 value_link_conflict` and changes nothing.

Ownership handoff, as in [[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]:
`Threads.company` and `Threads.project` stay `owner: user`; the `valueLinks` process writes them, as a system writer,
only while the thread's link for that property is `on`, and a user or agent write that changes the value ends the link
([[2026-09-10-single-writer-ownership-model]]).

Merge of two threads. The winner keeps its company and its project unless the loser's value takes precedence. A value
is inherited when the thread's link for that property is `on`, and its own otherwise (`broken`, or no link). An own value
beats an inherited one; between two values of one kind the thread with the older `mail_threads.created_at` wins, and a
tie keeps the winner's. A winner without a value takes the loser's. The link follows the value: the loser's link of an
adopted property replaces the winner's link, and the other links of the loser are deleted with it. The two properties are
decided apart. Afterwards the rules whose source is `Threads.project` are queued for the winner through the propagation
job, so what its attachments inherit is recomputed.

Every created or deleted edge of `Threads.company` or `Threads.project`, whoever wrote it, publishes the `mailThread`
invalidation of the thread after the commit (`threadValueEdgeChangedHook`).

## Consequences

- An item whose inputs changed holds its previous value until the `valueLinksPropagate` job has run.
- Nothing is backfilled. A thread that exists when the rules ship is evaluated when its first inbound message is
  ingested again, or when an input of its company changes.
- A change of the address list of a person (`People.emails`) and the move of a message between folders queue nothing,
  so a thread whose sender is affected only by them keeps its value until another input changes.
- The job of a person's or company's change finds the threads by a scan of the tenant's messages and relations, once per
  changed item; a person or company that wrote many threads queues one hundred evaluations to a transaction.
- The old `web` of a changed company is not known to the job. A thread written from the old host that matched the
  company together with another one has no company, so the job of a company also evaluates the threads that hold no
  company and were written from a domain of the host of any other company with a web.
- Moving a company or a project to the trash is not an input. The threads that matched a trashed company together
  with another one are evaluated again only when another input changes.
- Enqueue is unconditional. A write of a `People.companies` or `Companies.projects` edge or of a project's status queues
  a job even in a tenant that has no thread, and it needs a tenant scope like any propagation.
- The evaluation of a thread locks the thread item, then its link row, the order in which the edge hook and the
  engine's job lock a target and in which a merge locks the two thread items before it touches their links, so an
  evaluation waits for a merge that holds the thread and a merge waits for an evaluation that holds it.
- An own project survives a later change of the company, and an own company survives a change of the person's
  companies, because the link was ended or never existed.
- After a merge in which the company changes and the project does not, the winner's inherited project is recomputed by
  the project rule, which the company edge change queues; a project of its own is not.
