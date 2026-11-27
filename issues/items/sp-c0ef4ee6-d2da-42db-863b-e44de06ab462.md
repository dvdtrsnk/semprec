---
schemaVersion: 1
id: "sp-c0ef4ee6-d2da-42db-863b-e44de06ab462"
title: "[areas-removal 03/04] Remove areas from the mobile apps"
kind: "implementation"
state: "open"
stateReason: null
labels: ["spec:approved"]
parent: "sp-7ff00d8e-6c3e-49f2-b5a8-89ca1157e807"
assignees: []
milestone: null
createdAt: "2026-11-27T12:51:55.690Z"
updatedAt: "2026-11-27T12:52:01.027Z"
closedAt: null
source: null
approval: {"specSha256":"92169b45ab2bb9baef2ec11a884a8546c1e924250539b893d58dd63a1af7f7ba","source":"repository","actor":"david","at":"2026-11-27T12:52:01.027Z"}
resolution: null
---
**Blocked by:** sp-28bb2413-43da-438b-99ae-372da169ba94
**Model tier:** high

## Context

Model tier rationale: A wide removal across the shared KMP layer, CoreKit bridges, six Apple feature modules, the app
target's navigation and the architecture policy, which must leave every remaining screen and test working.

Areas are removed (parent epic). Android has no area code; web has none. In the shared layer and on Apple the area
appears as: the `AreasFeature` module and `AreaViewModel`/`AreasSDK`; `CollectionTarget.OfArea` and
`CollectionScope.Area` with `areaFilter` expansion; the Overview Areas section and `OverviewProject.areaName`;
`ProjectRef.areaId/areaTitle`; the tasks area filter (`TaskFilter.areaId`, `TasksAction.SetArea`); the mail area
filter and facet; `SearchGroupType.AREA`/`SearchSubtitleKind.AREA`; `InboxCardKind.AREA`; `SempTargetKind.AREA`;
`CatalogRepository.areas()` and the offline warm-up of areas; `area` in `CONTEXT_RELATIONS`; the project area link and
area section; app destinations and routers for an area. `InboxControl.AREA`, `InboxFieldType.AREA` and
`InboxAreaRow` are multi-line text controls, not areas, and stay.

## Task

1. Remove every area type, use case, repository method, ViewModel, bridge, screen, route, destination, router,
   identifier, copy key and test listed in Context, and the `AreasFeature` module with its Tuist and workspace entries.
2. Remove `area` from the expanded relations of tasks and projects and from `CONTEXT_RELATIONS`; the project
   settings and detail no longer show an area.
3. Update `mobile/scripts/architecture-policy.json` (targets, allowed dependencies, view models, copy keys) and the
   copy texts that mention areas ("oblast").

## Touches

- mobile/shared/core, domain, data, presentation, umbrella (area files and area branches) and their commonTest
- mobile/apple/Modules/Features/Areas (deleted)
- mobile/apple/Modules/Core/CoreKit, Features/Collections, Overview, Tasks, Mail, Inbox, Semp
- mobile/apple/Projects/App (navigation, routers, composition, Project.swift, tests), mobile/apple/Workspace.swift
- mobile/scripts/architecture-policy.json

## Scope

### In scope

- Removing every client area dependency.

### Out of scope

- Backend changes (sibling 04/04).
- Any replacement filter for tasks or mail.

## Acceptance criteria

- No Kotlin or Swift source or test under `mobile/` refers to the Areas concept (only the text-area controls remain).
- The overview shows no Areas section; the tasks and mail filters offer no area; project settings and detail show no
  area; search offers no area scope.
- The app opens every remaining destination with the server still serving areas, and with a server that serves none.
- `mobile/scripts/verify` passes for the architecture, shared and Apple steps on iOS and macOS.
