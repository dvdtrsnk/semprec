---
status: accepted
date: 2026-11-16
area: [mobile]
supersedes: []
superseded-by: null
---

# The collection screens are one schema-driven engine, and a file preview is drawn with ImageIO and CoreGraphics

## Context

The mobile design (`Principles.dc.html`) calls the collection ("sbirka") the template for every list of items: Projects,
People, Companies, Events, Files, and the databases a person creates are the same screen with different data. Writing
one screen per database would copy the same list, gallery, board, filter and detail logic five times, and each copy
would drift from the server's own idea of the collection (its quick filters, its default order, its collection filter,
the area filter it declares).

The server already describes all of that. `GET /api/schema` returns, per database, its properties, the quick-filter
chips with their filters, the default order, the filter that selects the items that belong in the collection, the area
filter template and the picker filter; `POST /api/databases/:id/query` and `/facets` answer any of them; `GET
/api/items/:id` answers the item with its value links and derived values.

A file preview needs the bytes of a blob drawn as an image. SwiftUI cannot decode image data without UIKit or AppKit,
which the apps do not import (`apple-swiftui`: one SwiftUI codebase for iOS and macOS, no `UIKit` or `AppKit`).

## Decision

- There is one shared `CollectionViewModel` and one `ItemViewModel` (`:shared:presentation`), configured by a
  `CollectionTarget` (a database by canonical key or id, narrowed to an area, to the items related to an item, or by a
  filter). Projects, People, Companies, Events and Files, and each of their area and project variants, are targets of
  the same screen. Nothing in them is written per database except what the schema cannot say: which relation
  properties describe where an item belongs (`area`, `project`, `projects`, `company`, `companies`, `people`), which
  select is the status of a collection (`status`, `type`, `relationship`) and the project layout of an item.
- The data layer reads and writes only what the server serves and keeps the filter grammar to itself: the domain passes
  opaque filter trees (`FilterTree`) and typed selections, and `:shared:data` builds the request bodies.
- The glass menu of a value that comes from another item is driven by the value links the server returns with the item
  (`valueKind`, `sources`, `brokenBy`), and its actions are the item link endpoints (`unlink`, `relink`) and a relation
  write. The app does not decide whether a value is inherited, derived or its own.
- A file preview is decoded in `CollectionsFeature` through `ImageIO` (images) and `CoreGraphics` (the first page of a
  PDF), and a picked file is typed through `UniformTypeIdentifiers`. These three are added to
  `apple.systemModules`. File bytes cross the Kotlin boundary as Base64 text, in both directions, so that no
  `KotlinByteArray` has to be built element by element.

## Consequences

- A new database that the server adds, with the properties and quick filters its module declares, is a working
  collection screen without app code, and a change of the server's default order or chips reaches the app by itself.
- The three relation, status and context key lists above are the app's one dependency on database vocabulary. A
  database that needs a different list changes them in one place (`CONTEXT_RELATIONS`, `groupProperty`).
- A preview exists for images ImageIO decodes and for PDFs; any other file shows its name, type and size, and can be
  handed to another app. A richer viewer is a decision of its own.
- Base64 costs a third more bytes in memory for a preview or an upload; files are bounded by the server's
  `maxFileSizeMb`.
