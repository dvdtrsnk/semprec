import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the calendar bridge's state, action and effect mappings with Kotlin values built here.
@MainActor
final class SharedCalendarMappingTests: XCTestCase {

    // MARK: - Phases and zoom
    func testStateMapsEveryPhase() {
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.loading)).phase, .loading)
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.content)).phase, .content)
        XCTAssertEqual(
            SharedCalendarScreenModel.state(CalendarKotlin.state(.error, failure: .unauthorized)).phase,
            .failure(.unauthorized)
        )
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.error)).phase, .failure(nil))
    }

    func testStateMapsEveryZoom() {
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.content, zoom: .year)).zoom, .year)
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.content, zoom: .month)).zoom, .month)
        XCTAssertEqual(SharedCalendarScreenModel.state(CalendarKotlin.state(.content, zoom: .day)).zoom, .day)
    }

    func testStateMapsTheScalarsTheGridAndTheYear() {
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, problemFailure: .rejected))
        XCTAssertEqual(state.selectedDay, "2026-10-16")
        XCTAssertEqual(state.today, "2026-10-15")
        XCTAssertEqual(state.nowMinutes, 804)
        XCTAssertEqual(state.monthGrid, ["2026-09-28", "2026-09-29"])
        XCTAssertEqual(state.months, [CoreKit.CalendarMonthState(year: 2026, month: 10, leading: 3, length: 31)])
        XCTAssertEqual(state.pendingInvitations, 3)
        XCTAssertEqual(state.selectedItemId, "e1")
        XCTAssertTrue(state.busy)
        XCTAssertTrue(state.problem)
        XCTAssertEqual(state.problemFailure, .rejected)
        XCTAssertNil(SharedCalendarScreenModel.state(CalendarKotlin.state(.content)).problemFailure)
    }

    // MARK: - Days and items
    func testStateMapsADayWithItsItemsAndSleep() {
        let task = SharedSDK.CalendarEventTask(id: "t1", title: "Agenda", state: .doneElsewhere, note: "Review")
        let day = SharedSDK.CalendarDayState(
            date: "2026-10-16",
            items: [CalendarKotlin.item(tasks: [task], trace: .movedToEvent)],
            sleepEvening: CalendarKotlin.sleep(),
            sleepMorning: nil
        )
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, days: [day]))
        let mapped = state.days.first
        XCTAssertEqual(mapped?.date, "2026-10-16")
        XCTAssertEqual(
            mapped?.sleepEvening,
            CoreKit.CalendarSleep(
                night: "2026-10-15",
                bedMinutes: 1380,
                wakeMinutes: 405,
                alarm: true,
                changed: true,
                prepMinutes: 1350
            )
        )
        XCTAssertNil(mapped?.sleepMorning)
        let item = mapped?.items.first
        XCTAssertEqual(item?.title, "Meeting")
        XCTAssertEqual(item?.color, "#007AFF")
        XCTAssertEqual(item?.endDate, "2026-10-18")
        XCTAssertEqual(item?.startMinutes, 600)
        XCTAssertEqual(item?.endMinutes, 660)
        XCTAssertEqual(item?.column, 1)
        XCTAssertEqual(item?.columns, 3)
        XCTAssertEqual(item?.place, "Office")
        XCTAssertEqual(item?.hostEventTitle, "Review")
        XCTAssertEqual(item?.carriedFrom, "2026-10-14")
        XCTAssertEqual(item?.traceNote, "2026-10-15")
        XCTAssertEqual(item?.trace, .movedToEvent)
        XCTAssertEqual(
            item?.tasks,
            [CoreKit.CalendarEventTask(id: "t1", title: "Agenda", state: .doneElsewhere, note: "Review")]
        )
        XCTAssertEqual(
            [item?.hasEnd, item?.done, item?.missed, item?.tentative, item?.editable],
            [true, true, true, true, false]
        )
    }

    func testAnAllDayItemHasNoTimes() {
        let day = SharedSDK.CalendarDayState(
            date: "2026-10-16", items: [CalendarKotlin.item(allDay: true, start: nil, end: nil)],
            sleepEvening: nil, sleepMorning: CalendarKotlin.sleep()
        )
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(.content, days: [day]))
        XCTAssertNil(state.days.first?.items.first?.startMinutes)
        XCTAssertNil(state.days.first?.items.first?.endMinutes)
        XCTAssertEqual(state.days.first?.items.first?.allDay, true)
        XCTAssertNotNil(state.days.first?.sleepMorning)
    }

    func testItemKindsMapOneToOne() {
        let kinds: [SharedSDK.CalendarItemKind] = [.event, .task, .birthday, .holiday, .sleep, .trace]
        let mapped = kinds.map { CoreKit.CalendarItemKind($0) }
        XCTAssertEqual(mapped, [.event, .task, .birthday, .holiday, .sleep, .trace])
    }

    func testTaskStatesInAnEventMapOneToOne() {
        let states: [SharedSDK.CalendarTaskInEvent] = [.open, .missed, .done, .doneElsewhere, .moved]
        XCTAssertEqual(states.map { CoreKit.CalendarTaskInEvent($0) }, [.open, .missed, .done, .doneElsewhere, .moved])
    }

    func testTraceOutcomesMapOneToOne() {
        let outcomes: [SharedSDK.CalendarTraceOutcome] = [.carried, .done, .movedToEvent, .missed]
        XCTAssertEqual(outcomes.map { CoreKit.CalendarTraceOutcome($0) }, [.carried, .done, .movedToEvent, .missed])
    }

    // MARK: - Drag, clipboard and delete
    func testStateMapsTheDragTheClipboardAndTheDelete() {
        let drag = SharedSDK.CalendarDrag(
            itemId: "e1", date: "2026-10-17", allDay: false, startMinutes: KotlinInt(int: 900),
            endMinutes: KotlinInt(int: 960), intoEventId: "e2", committing: true
        )
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(
            .content,
            drag: drag,
            clipboard: SharedSDK.CalendarClipboard(mode: .copied, title: "Meeting"),
            pendingDelete: SharedSDK.CalendarDeleteRequest(itemId: "e1", title: "Meeting", kind: .task)
        ))
        XCTAssertEqual(
            state.drag,
            CoreKit.CalendarDrag(
                itemId: "e1", date: "2026-10-17", allDay: false, startMinutes: 900, endMinutes: 960,
                intoEventId: "e2", committing: true
            )
        )
        XCTAssertEqual(state.clipboard, CoreKit.CalendarClipboard(mode: .copied, title: "Meeting"))
        XCTAssertEqual(state.pendingDelete, CoreKit.CalendarDeleteRequest(itemId: "e1", title: "Meeting", kind: .task))
    }

    func testTheCutClipboardMode() {
        let state = SharedCalendarScreenModel.state(CalendarKotlin.state(
            .content, clipboard: SharedSDK.CalendarClipboard(mode: .cut, title: "x")
        ))
        XCTAssertEqual(state.clipboard?.mode, .cut)
        XCTAssertNil(state.drag)
        XCTAssertNil(state.pendingDelete)
    }

    // MARK: - Actions
    func testNavigationActionsMapEveryCase() throws {
        XCTAssertTrue(SharedCalendarScreenModel.action(.navigation(.retry)) is SharedSDK.CalendarActionNavigationRetry)
        XCTAssertTrue(
            SharedCalendarScreenModel.action(.navigation(.refresh)) is SharedSDK.CalendarActionNavigationRefresh
        )
        XCTAssertTrue(
            SharedCalendarScreenModel.action(.navigation(.goToday)) is SharedSDK.CalendarActionNavigationGoToday
        )
        let show = try XCTUnwrap(
            SharedCalendarScreenModel.action(.navigation(.show(zoom: .month, day: "2026-10-16")))
                as? SharedSDK.CalendarActionNavigationShow
        )
        XCTAssertEqual(show.zoom, .month)
        XCTAssertEqual(show.day, "2026-10-16")
        let page = try XCTUnwrap(
            SharedCalendarScreenModel.action(.navigation(.page(steps: -2))) as? SharedSDK.CalendarActionNavigationPage
        )
        XCTAssertEqual(page.steps, -2)
    }

    func testZoomsMapBackToKotlin() {
        XCTAssertEqual(CoreKit.CalendarZoom.year.shared, .year)
        XCTAssertEqual(CoreKit.CalendarZoom.month.shared, .month)
        XCTAssertEqual(CoreKit.CalendarZoom.day.shared, .day)
    }

    func testGestureActionsMapEveryCase() throws {
        typealias Model = SharedCalendarScreenModel
        XCTAssertEqual((Model.action(.gesture(.tap(itemId: "a"))) as? SharedSDK.CalendarActionGestureTap)?.itemId, "a")
        XCTAssertTrue(Model.action(.gesture(.tapBackground)) is SharedSDK.CalendarActionGestureTapBackground)
        XCTAssertEqual(
            (Model.action(.gesture(.select(itemId: "b"))) as? SharedSDK.CalendarActionGestureSelect)?.itemId,
            "b"
        )
        XCTAssertEqual(
            (
                Model.action(.gesture(.toggleDone(itemId: "c"))) as? SharedSDK.CalendarActionGestureToggleDone
            )?.itemId, "c"
        )
        let move = try XCTUnwrap(
            Model.action(
                .gesture(
                    .dragMove(itemId: "d", day: "2026-10-17", rawStart: 905, overAllDayRow: true, overEventId: "e")
                )
            )
                as? SharedSDK.CalendarActionGestureDragMove
        )
        XCTAssertEqual([move.itemId, move.day, move.overEventId], ["d", "2026-10-17", "e"])
        XCTAssertEqual(move.rawStart, 905)
        XCTAssertTrue(move.overAllDayRow)
        let resize = try XCTUnwrap(
            Model.action(
                .gesture(.dragResize(itemId: "f", edge: .end, rawMinutes: 700))
            ) as? SharedSDK.CalendarActionGestureDragResize
        )
        XCTAssertEqual(resize.edge, .end)
        XCTAssertEqual(resize.rawMinutes, 700)
        let start = try XCTUnwrap(
            Model.action(
                .gesture(.dragResize(itemId: "f", edge: .start, rawMinutes: 1))
            ) as? SharedSDK.CalendarActionGestureDragResize
        )
        XCTAssertEqual(start.edge, .start)
        XCTAssertEqual(
            (Model.action(.gesture(.endDrag(commit: true))) as? SharedSDK.CalendarActionGestureEndDrag)?.commit,
            true
        )
        let toDay = try XCTUnwrap(
            Model.action(
                .gesture(.moveToDay(itemId: "g", day: "2026-10-20"))
            ) as? SharedSDK.CalendarActionGestureMoveToDay
        )
        XCTAssertEqual([toDay.itemId, toDay.day], ["g", "2026-10-20"])
    }

    func testEditActionsMapEveryCase() throws {
        typealias Model = SharedCalendarScreenModel
        XCTAssertEqual((Model.action(.edit(.cut(itemId: "a"))) as? SharedSDK.CalendarActionEditCut)?.itemId, "a")
        XCTAssertEqual((Model.action(.edit(.copy(itemId: "b"))) as? SharedSDK.CalendarActionEditCopy)?.itemId, "b")
        XCTAssertEqual(
            (Model.action(.edit(.duplicate(itemId: "c"))) as? SharedSDK.CalendarActionEditDuplicate)?.itemId,
            "c"
        )
        let paste = try XCTUnwrap(
            Model.action(
                .edit(.paste(day: "2026-10-17", rawStart: 540, allDay: true))
            ) as? SharedSDK.CalendarActionEditPaste
        )
        XCTAssertEqual([paste.day], ["2026-10-17"])
        XCTAssertEqual(paste.rawStart, 540)
        XCTAssertTrue(paste.allDay)
        XCTAssertEqual(
            (
                Model.action(.edit(.requestDelete(itemId: "d"))) as? SharedSDK.CalendarActionEditRequestDelete
            )?.itemId, "d"
        )
        XCTAssertTrue(Model.action(.edit(.confirmDelete)) is SharedSDK.CalendarActionEditConfirmDelete)
        XCTAssertTrue(Model.action(.edit(.cancelDelete)) is SharedSDK.CalendarActionEditCancelDelete)
        XCTAssertTrue(Model.action(.edit(.dismissProblem)) is SharedSDK.CalendarActionEditDismissProblem)
    }

    func testOpenActionsMapEveryCase() {
        typealias Model = SharedCalendarScreenModel
        XCTAssertTrue(Model.action(.open(.calendars)) is SharedSDK.CalendarActionOpenCalendars)
        XCTAssertTrue(Model.action(.open(.invitations)) is SharedSDK.CalendarActionOpenInvitations)
        XCTAssertEqual((Model.action(.open(.newItem(day: "d"))) as? SharedSDK.CalendarActionOpenNewItem)?.day, "d")
        XCTAssertEqual((Model.action(.open(.sleep(night: "n"))) as? SharedSDK.CalendarActionOpenSleep)?.night, "n")
    }

    // MARK: - Effects
    func testEffectsMapEveryCase() {
        typealias Model = SharedCalendarScreenModel
        XCTAssertEqual(
            Model.effect(SharedSDK.CalendarEffectOpenDetails(itemId: "e1", kind: .task, day: "2026-10-16")),
            .openDetails(itemId: "e1", kind: .task, day: "2026-10-16")
        )
        XCTAssertEqual(Model.effect(SharedSDK.CalendarEffectOpenCalendars.shared), .openCalendars)
        XCTAssertEqual(Model.effect(SharedSDK.CalendarEffectOpenInvitations.shared), .openInvitations)
        XCTAssertEqual(Model.effect(SharedSDK.CalendarEffectOpenNewItem(day: "d")), .openNewItem(day: "d"))
        XCTAssertEqual(Model.effect(SharedSDK.CalendarEffectOpenSleep(night: "n")), .openSleep(night: "n"))
    }
}
