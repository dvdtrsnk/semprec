---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The trash of an Event locks the value links it feeds in item order, then rule order

## Context

[[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]] states the order of the rows of one transcript, file or task (the item row, then the `project`, `people` and `company` link rows) and lists three paths of the tree that take value link rows against it. This decision repairs the first of them, which that record does not repair and whose body this record leaves as it is: the trash of an Event takes the `project` and `people` links it feeds in the order of their link ids, while the release of a removed `Transcripts.event` edge takes `project` and then `people`.

Moving an Event to the Trash runs `valueLinkSourceDeleteHook`, which detaches every value link the Event is a source of with `deleteValueLinkSourcesBySourceItem` (`chokePoint/valueLinksStore.ts`). The function selected the links `ORDER BY l.id FOR UPDATE`. For a transcript linked to the Event those are its `project` and `people` links. Removing the transcript's `event` edge (a user `deleteRelation` of `Transcripts.event`) runs the engine's edge-changed hook, which evaluates the link rules in catalog order and so locks the `project` link and then the `people` link (`linkRuleEdgeHook`), and then the release hook `transcriptCompanyLinkReleaseEdgeChangedHook` (`transcription/transcriptCompanyLinkRelease.ts`), which locks `project`, `people` and `company` the same way; [[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]] records the release order. When the transcript's `people` link has the smaller id, the trash took `people` and then `project`, the edge removal took `project` and then `people`, and with a third transaction holding the `project` link row the two ended with `40P01` (the trash losing in the run that was inspected).

The propagation job (`handleLinkPropagation`) sorts the links of a page by item id and locks, for each, the item row and then that one link, as [[2026-11-05-value-link-propagation-keeps-separate-hop-budgets]] has it. So a trash that detaches the links of several items needs one total order that agrees with it and with the catalog order the engine uses for the links of one item.

## Decision

The detach locks the links an Event feeds in this order:

1. the id of the link's item;
2. the position of the link's rule in the rule catalog (`loadLinkRules` in `valueLinks/linkRuleCatalog.ts`, which is the order of the modules and then of their manifests, and the order in which the engine evaluates the rules of one item);
3. the id of the link.

Each key has its reason. The item id is the order in which the propagation job locks the links of its page. The position of the rule is the order in which the engine and the release hooks take the links of one item, so the trash takes the `project` link before the `people` link whichever has the smaller id. The link id is a deterministic tiebreak for links of one item and rule.

`deleteValueLinkSourcesBySourceItem(client, sourceItemId, ruleKeyOrder = [])` takes the rule keys in catalog order as a third parameter and selects the links `ORDER BY l.item_id, array_position($2::text[], l.rule_key), l.id FOR UPDATE`. A link whose rule is not in the list, or any link when the list is empty, sorts after the others of its item and by link id. The returned array keeps the order of the locks. `valueLinkSourceDeleteHook` passes the rule keys of `loadLinkRules()`.

The purge's call of the same function (`deleteItemDependents` in `chokePoint/itemTrash.ts`) keeps the default, the empty list, and so the order of the item id and then the link id. It runs after the purged item's edges are deleted and under the tenant purge lock, so it cannot meet the removal of an `event` edge, and there is no schedule on that path to repair. Passing the catalog there would only add a catalog read to it.

A later detach or release that takes the links of several items or rules of one Event follows this order, or records the limit with a measured schedule.

## Consequences

Measured, with production calls on pools of the runtime role `semprec_data`, one pool and one `application_name` per participant, and a third transaction holding the transcript's `project` link row:

- `__tests__/eventTrashValueLinkLockOrder.test.ts` runs a user `deleteRelation` of the transcript's `event` edge and a user `softDeleteItem` of the Event in both start orders, each started only after the one before waits for a lock, and with the transcript's `project` link and with its `people` link having the smaller id (the ids are rewritten on the admin pool). All four combinations commit, the Event is in the Trash, the `event` edge is gone, and the transcript keeps its `project` and `company` edges and has no value link row. On the tree before this change the combination of the edge removal started first and the `people` link having the smaller id ends the trash with `40P01`; the other three commit.
- `__tests__/valueLinksStore.test.ts` shows that the function locks and returns the links of two items, each with a `project` and a `people` link, in the order of the item id, the position of the rule and the link id when the ids are rewritten so that the link-id order differs from both, and by item id and link id for an empty or an omitted rule order and, for a partial one, by item id, then the links of the named rules in their order, then the others by link id.
- `valueLinkSourceDeleteHook.test.ts`, `valueLinkEdgeBreakLockOrder.test.ts`, `valueLinkWrites.test.ts`, `itemTrash.test.ts` and the files of `transcription/__tests__` pass unchanged.

Not measured:

- The order against `moveValueLinkItemSources` and the approval reservations, which order the links by link id. `moveValueLinkItemSources` moves the sources of a task, which are links of a different rule from those an Event feeds, and `lockOnValueLinksOfProperties` share-locks the links of the two sides of one edge, at most one per item. Neither orders several links of one item that an Event feeds, but no schedule was run against either.
- Two paths of [[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]] that this change does not repair: the trash of an Event that hosts a task which is also sourced from it, and the replay of an approved `relation.delete`, `relation.put` or `relation.set`. Each is the subject of its own source.

The sentence of the 2026-11-15 record that the order of the item's rows is not total stays true: this decision orders the links the trash of an Event detaches, not every path that takes them.
