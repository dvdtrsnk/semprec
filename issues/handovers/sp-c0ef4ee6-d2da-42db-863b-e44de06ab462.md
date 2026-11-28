## What was delivered

- Every area type, use case, repository method, ViewModel, bridge, screen, route, destination, identifier, copy key
  and test was removed from `mobile/shared` and `mobile/apple`, with the `AreasFeature` module and its
  architecture-policy entries. `InboxControl.AREA`, `InboxFieldType.AREA` and `InboxAreaRow` are text-area controls
  and stay. `Theme.Colors.SempKind.area` was replaced by `Theme.Colors.sempTick`.

## Contracts dependents build on

- The apps no longer read the `areas` database, `areaFilter`, `derived.area` or any area field; the mail list cache key
  no longer contains `area=`.
