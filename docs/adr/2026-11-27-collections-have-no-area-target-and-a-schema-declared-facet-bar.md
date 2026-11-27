---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# Collections have no area target, and a facet bar is declared by the schema

## Context

[[2026-11-16-collection-screens-are-one-schema-driven-engine-and-file-previews-use-imageio-and-coregraphics]] made
every collection one schema-driven screen configured by a `CollectionTarget`, one of which narrows a database "to an
area" through the area filter template the server declares, and it lists `area` among the relation keys that
describe where an item belongs.

Areas are removed from Semprec (repository issue `sp-7ff00d8e-6c3e-49f2-b5a8-89ca1157e807`): the owner found the
layer hard to understand and manage, and projects are organized by tags instead. The projects collection needs a bar
of tag chips above its list. Turning that bar on with a check of the database key in the app would be the
per-database code the collection engine exists to avoid.

Other records mention areas as examples of what they cover (the offline warm-up in
[[2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind]], the reloaded counts in
[[2026-11-16-open-mobile-screens-reload-after-any-write-of-their-window]], a host that is not a page in
[[2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position]]). Their decisions do not depend on
areas and stay as they are; the area examples no longer exist.

## Decision

- This narrows the collection engine decision: `CollectionTarget` has no area variant, the data layer builds no area
  scope (there is no area filter template to expand), and `area` is not a context relation. The rest of that decision
  holds.
- A database may declare one `facetBarProperty` in its module manifest (a `select` or `multi_select` property key),
  published per database by `GET /api/schema`. When the collection's database declares one, the shared
  `CollectionViewModel` reads that property's facet with the screen and after every change of the query, and shows
  its values as a row of chips above the list. A chip toggles the value in the same selection the filter sheet edits,
  and the sheet offers the bar's property even before the schema knows any of its values, so the bar and the sheet
  cannot disagree. The bar is hidden when the facet has no value, and a collection row lists the item's values of
  that property in its subtitle.
- Projects declares `facetBarProperty: "tags"`; no other database declares one.

## Consequences

- A database gains a chip bar by a server manifest change, without app code.
- The bar costs one facet request per query change on a database that declares it.
- Selecting several chips selects items having any of them, because a `multi_select` selection is an `in` filter.
