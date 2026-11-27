## What was delivered

- The `areaFilter` manifest contract is removed: the module-registry type, schema and projection,
  `views/areaFilter.ts` (`expandAreaFilter`, `resolveDatabaseAreaFilters`), the collection metadata resolver, the area
  related routes, the area-filter facets and every `areaFilter` declaration in the system databases manifest.
  `GET /api/schema` publishes no `areaFilter` and still publishes `facetBarProperty: "tags"` for Projects.
- A Projects facet value carries the project's own `color`.
- The derived area is removed: its derived-value sources and guarded sources, its reads, its value-link kind,
  `derived.area` in the shared `Item` row type and `projectAttachmentAreaHook`. The Event company derived through its
  project keeps its guard, admission and `derivedValuesInvalidate` job.
- Mail list, delta and facets take no `areaId`; the `areas` facet group and the area branch of the thread change hook
  are gone. The sleep settings response has no `areaId`; `area` left `EVENT_RELATION_KEYS`.
- The Areas database, its relations, the area write hook and `GET /api/areas/:id/overview` are still in place.

## Contracts dependents build on

- Mail facets return `{ total, projects }`, and project facet items carry no `areaId`; the mail list query's positional
  parameters were renumbered (person `$7` onward).
- `Item.derived` has only `company`; `DERIVED_VALUE_SOURCES` and `GUARDED_DERIVED_VALUE_SOURCES` name only the Events
  `project`/`company` path.
