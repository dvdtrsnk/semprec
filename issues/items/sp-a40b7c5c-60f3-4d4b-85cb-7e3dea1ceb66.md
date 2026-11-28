---
schemaVersion: 1
id: "sp-a40b7c5c-60f3-4d4b-85cb-7e3dea1ceb66"
title: "[internet-accounts] Choose the new item calendar in a sectioned list, keep titles on one line and present the delete confirmation accessibly"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-85e6cbc4-7de7-4385-81a9-a493c421b817"
assignees: []
milestone: null
createdAt: "2026-11-21T11:43:55.694Z"
updatedAt: "2026-11-21T13:24:31.969Z"
closedAt: "2026-11-21T13:24:31.969Z"
source: null
approval: {"specSha256":"361042f1b38cb548d802161678c735f8abfd3b2ae2a35191fde7020d7b9248fe","source":"repository","actor":"claude-delegated-by-david: delegated by dvdtrsnk for the internet accounts fixes, 2026-11-21","at":"2026-11-21T11:44:05.861Z"}
resolution: {"pullRequests":[],"commit":"6577964ade3666647894dd960ac0a6c96c71e6e6","at":"2026-11-21T13:24:31.969Z"}
---
**Blocked by:** none
**Model tier:** medium

## Context

Model tier rationale: Three contained Apple UI defects with one small shared title rule and one shared ViewModel state change; no new module, route, exported type or backend change.

Testing the iOS app on an iPhone 18 Pro simulator against the dev server found three defects.

- The calendar row of the new item sheet (`newItem.calendar`, `NewItemFormView.calendarRow`) is a `Menu` with an inline `Picker` whose `Section`s are one per calendar group. iOS renders it as one flat menu: the section titles ("My Calendars", "iCloud · david@tresnak.cc") are not shown, every colour dot is grey because a menu draws its images as templates, and the two calendars named "Osobní" look the same in the menu. Only the chosen value in the row reads "Osobní · iCloud". The groups, the account and `NewItemCalendarQualifier` already arrive from the shared `NewItemState`, and `NewItemOptions.title(of:)` and `label(of:)` already compose the texts.
- The title of the event and task details sheet (`taskDetails.title`, `ItemDetailsScreen`) is a `TextField` with `axis: .vertical`, so Return inserts a line break and the saved title contains `\n`. The project and media title fields of Collections (`item.title`, `ProjectContent`, `MediaItemContent`) are vertical too and save on submit. The new item title is a single-line field, but a pasted title can still carry line breaks. Titles are trimmed in `ItemDetailsChanges` (`SetTitle`), `titleChange` (Collections rename), `TasksViewModel` (`Rename`) and `CreateCalendarItem`, none of which removes line breaks.
- Choosing Delete in an event's menu (`calendar.menu`, a popover the selected item presents) asks "Delete the event …?" in a SwiftUI `.alert` on `CalendarScreen`. `CalendarViewModel.requestDelete` sets `pendingDelete` but keeps `selectedItemId`, so the menu stays presented and the alert is presented on top of the popover. AXe's `describe-ui` did not list the alert, so automation and possibly VoiceOver cannot reach it, and its buttons have no identifiers.

## Task

Load `kmp-shared`, `shared-viewmodel`, `apple-swiftui`, `canonical-keys`, `testing` and `mobile-verify`.

1. Calendar chooser: tapping the new item calendar row (still `newItem.calendar`) presents a chooser sheet titled with `newItem.calendar`: a list with one section per group, headed by `NewItemOptions.title(of:)`, each calendar a row with its colour drawn as a real view (not a template image), its name and a checkmark on the chosen one. A row's accessibility label is `NewItemOptions.label(of:)`, so a duplicate name is told apart without the header. Choosing a row sets the form's calendar and closes the sheet; a `calendars.done` button closes it without a change. Identifiers: `newItem.calendar.chooser` for the sheet, `newItem.calendar.option.<calendarId>` per row, `newItem.calendar.done` for the button. The sections and rows are computed in a testable value type. No new copy key.
2. Single-line titles, shared: a domain function turns every line break with the whitespace around it into one space and trims; `ItemDetailsChanges` (`SetTitle`), `titleChange`, `TasksViewModel` (`Rename`) and `CreateCalendarItem` use it, so no saved title contains a line break.
3. Single-line titles, Apple: a DesignSystem binding for a title field whose Return press (a line break added and nothing else changed) ends editing instead of inserting the break, and whose pasted line breaks become spaces. The details sheet's title and the Collections project and media titles use it and keep wrapping long titles; Return ends editing and saves (details: the field loses focus, which commits; Collections: rename). Each of these fields gets `.submitLabel(.done)`.
4. Delete confirmation: requesting a delete closes the item menu (`requestDelete` clears `selectedItemId`), so the alert is presented by the calendar screen and not over the popover. The alert's buttons get the identifiers `calendar.delete.confirm` and `calendar.delete.cancel`. If the alert is still missing from AXe's tree after that, the cause is recorded in the handover.

## Touches

- mobile/shared/domain/src/commonMain/kotlin/cz/alldots/app/domain/ (title rule, CalendarUseCases.kt)
- mobile/shared/presentation/src/commonMain/kotlin/cz/alldots/app/presentation/ItemDetailsChanges.kt, ItemChanges.kt, TasksViewModel.kt, CalendarViewModel.kt
- mobile/shared/*/src/commonTest/
- mobile/apple/Modules/Core/DesignSystem/ (title binding and its tests)
- mobile/apple/Modules/Features/Calendar/ (chooser, form row, delete alert identifiers, tests)
- mobile/apple/Modules/Features/Tasks/ (details title)
- mobile/apple/Modules/Features/Collections/ (project and media titles)

## Scope

### In scope

- The calendar chooser of the new item sheet, single-line titles on the listed fields and in the shared layer, and the delete confirmation's presentation and identifiers.

### Out of scope

- An XCUITest of the calendar flows: `AlldotsUITests` covers only the session gate and has no signed-in or scripted calendar to walk.
- Android and web; the backend.
- Other text fields (descriptions, notes, names of calendars or accounts).

## Acceptance criteria

- The new item calendar row opens a chooser with a section per source ("My Calendars", "iCloud · david@tresnak.cc"), coloured dots, a checkmark on the chosen calendar and a per-row identifier; choosing a row changes the form's calendar.
- Pressing Return in the details title ends editing and saves no line break; a title with line breaks is saved with spaces by every listed shared path.
- Choosing Delete in the item menu closes the menu and shows the confirmation whose buttons carry identifiers; confirming deletes and cancelling keeps the item.
