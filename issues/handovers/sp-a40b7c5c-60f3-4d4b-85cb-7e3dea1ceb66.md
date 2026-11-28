# Handover: choose the new item calendar in a sectioned list, keep titles on one line and present the delete confirmation accessibly

Implementation commits `6577964ad`, `845e76b55` and `450cc6747` on `feat/internet-accounts`.

**Calendar chooser (Apple).**
- The new item calendar row (`newItem.calendar`) is a button. It shows the chosen calendar's dot and `NewItemOptions.label(of:)`, for example "Osobní · iCloud".
- A tap presents `NewItemCalendarChooser` as a sheet (medium and large detents) titled `newItem.calendar`. It has one section per group, headed by `NewItemOptions.title(of:)` ("My Calendars", "iCloud · david@tresnak.cc"). Each row has a colour dot drawn as a `Circle`, so no template rendering applies, the calendar's name, and a checkmark on the chosen calendar. Choosing a row sets the form's calendar and closes the sheet. `calendars.done` closes it without a change.
- A row's accessibility label is `label(of:)`, so VoiceOver tells two calendars with the same name apart without reading the section header. The chosen row carries the selected trait.
- New identifiers:
  - `newItem.calendar.chooser` for the list.
  - `newItem.calendar.section.<own|account.<id>>` for the section headers.
  - `newItem.calendar.option.<calendarId>` for the rows.
  - `newItem.calendar.done` for the button.
- `NewItemCalendarChoices` computes the sections and rows, and `NewItemCalendarPickerTests` reads it over `ScriptedNewItemScreenModel`. No new copy key.

**Single-line titles.**
- Shared: `singleLineTitle` in the domain turns each line break, with the whitespace around it, into one space and trims. It is used by `CreateCalendarItem`, `ItemDetailsChanges` (`SetTitle`), `titleChange` (Collections rename) and `TasksViewModel` (`Rename`, `Add`).
- Apple: the DesignSystem modifier `singleLineTitle(_:onReturn:)` uses `SingleLineEdit`.
  - A Return press (a line break added and nothing else changed) is undone and calls `onReturn`. On a Mac, Return arrives as a submit, which calls `onReturn` too.
  - Pasted line breaks become spaces.
  - The modifier also sets `.submitLabel(.done)`.
- The modifier is used on the details title (`taskDetails.title`; Return drops the focus, which commits) and on the Collections project and media titles (Return drops the focus and renames). These fields keep `axis: .vertical`, so long titles still wrap.
- The new item title is already a single-line field. Its pasted line breaks are removed by the shared rule when it is saved.

**Delete confirmation.**
- `CalendarViewModel.requestDelete` now clears `selectedItemId`, so the item menu (a popover) closes and the calendar screen alone presents the alert, as in the system Calendar.
- The alert buttons have the identifiers `calendar.delete.confirm` and `calendar.delete.cancel`.
- AXe finding: the reported defect did not reproduce. I tested on an iPhone 18 Pro simulator with a temporary harness (not committed) that showed `CalendarScreen` over preview data, both with the old behaviour (menu kept) and the new one (menu closed). In both cases AXe's `describe-ui` listed the alert as a `Sheet` with its title, message and the `Cancel` and `Delete` buttons, because the alert is a standard alert in the app's own process.
- SwiftUI did not reliably pass `.accessibilityIdentifier` on alert buttons to the accessibility tree. The identifiers appeared in one run and not in the later ones. Automation should find the buttons by role and label inside the alert (`app.alerts.buttons`) when the identifier is missing.
- No XCUITest was added: `AlldotsUITests` covers only the session gate and has no signed-in or scripted calendar.

**Deviations from the Task wording.**
- The DesignSystem helper is a view modifier over an `onChange` of the bound text, not a wrapping `Binding`. A binding that refuses the line break leaves its state unchanged, so SwiftUI does not redraw and the field keeps showing the break. The modifier lets the break land and then removes it.
- The task list's new task title (`TasksAction.Add`) also passes the shared rule, because it is saved the same way as a renamed title.

**Not changed.** Android, web and the backend. Other text fields (descriptions, notes, calendar and account names).

**Verification** (`mobile/scripts/verify architecture shared apple --ios-simulator <reserved iPhone 18 Pro>`).
- First run: shared FAIL on detekt (a long line and `CalendarViewModelTest` over the size limit). Fixed in `450cc6747`.
- Second run:
  - Architecture PASS.
  - Shared PASS: JVM 1533, macOS native 1527 and iOS simulator native 1527 tests, detekt included.
  - SwiftLint, Tuist, all six Apple builds and the UI-test build PASS.
  - `test on macOS` hung for over an hour without running a test bundle, so the run was stopped. The remaining test steps were run by hand with the same commands:
    - `Alldots` on the iOS simulator: 769/769 passed, among them CoreKitTests 311, CalendarFeatureTests 81 and DesignSystemTests 4.
    - `AlldotsUITests`: passed.
    - macOS: retried once by hand, and it hung again before running a test bundle, so it was stopped. macOS tests are NOT RUN.
- On the simulator, the chooser, the choice of a calendar (the row then reads "Osobní · iCloud") and Return in a single-line title (no line break, `onReturn` called once) were driven through AXe in the temporary harness.
