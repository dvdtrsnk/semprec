import XCTest

@testable import CoreKit

/// Drives the real Kotlin calendar ViewModels through the native bridges. The test host has no signed-in session, so
/// every read ends in an unauthorized failure without a request, which is enough to show the bridges deliver state and
/// effects and close their ViewModels.
final class SharedCalendarScreenModelTests: XCTestCase {

    // MARK: - Calendar
    @MainActor
    func testTheCalendarOpensOnTheGivenDayAndWithoutASessionEndsUnauthorized() async {
        let model = SharedScreenModelFactory().makeCalendar(initialDay: "2026-10-14")
        XCTAssertEqual(model.state.selectedDay, "2026-10-14")
        XCTAssertEqual(model.state.zoom, .day)
        XCTAssertEqual(model.state.monthGrid.count, 42)
        XCTAssertEqual(model.state.months.count, 12)
        let failed = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(failed)
    }

    @MainActor
    func testZoomingAndPagingReachTheKotlinViewModel() async {
        let model = SharedScreenModelFactory().makeCalendar(initialDay: "2026-10-14")
        model.send(.navigation(.show(zoom: .month, day: "2026-11-02")))
        let shown = await waitForState(model) { $0.zoom == .month && $0.selectedDay == "2026-11-02" }
        XCTAssertNotNil(shown)
        model.send(.navigation(.page(steps: 1)))
        let paged = await waitForState(model) { $0.selectedDay == "2026-12-02" }
        XCTAssertNotNil(paged)
    }

    @MainActor
    func testRetryMakesTheKotlinCalendarLoadAgain() async throws {
        let model = try XCTUnwrap(
            SharedScreenModelFactory().makeCalendar(initialDay: "2026-10-14") as? SharedCalendarScreenModel
        )
        _ = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        let failed = model.viewModel.state.value
        model.send(.navigation(.retry))
        XCTAssertFalse(model.viewModel.state.value === failed, "Retry must start a new load of the Kotlin ViewModel")
        let again = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(again)
    }

    @MainActor
    func testCalendarEffectsAreDeliveredOnceInOrder() async {
        let model = SharedScreenModelFactory().makeCalendar(initialDay: "2026-10-14")
        model.send(.open(.calendars))
        model.send(.open(.invitations))
        model.send(.open(.newItem(day: "2026-10-15")))
        model.send(.open(.sleep(night: "2026-10-14")))
        let received = await effects(of: model, count: 4)
        XCTAssertEqual(
            received,
            [.openCalendars, .openInvitations, .openNewItem(day: "2026-10-15"), .openSleep(night: "2026-10-14")]
        )
        let again = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(again, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testReleasingTheCalendarBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedCalendarScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeCalendar(initialDay: "2026-10-14") as? SharedCalendarScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        XCTAssertFalse(lease.isClosed)
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished)
    }

    // MARK: - Calendars list
    @MainActor
    func testTheCalendarsListWithoutASessionEndsUnauthorizedAndDeliversItsEffect() async {
        let model = SharedScreenModelFactory().makeCalendarList()
        let failed = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(failed)
        model.send(.openSleep)
        let received = await effects(of: model, count: 1)
        XCTAssertEqual(received, [.openSleep])
    }

    @MainActor
    func testReleasingTheCalendarsListBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedCalendarListScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeCalendarList() as? SharedCalendarListScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }

    // MARK: - Invitations
    @MainActor
    func testTheInvitationsWithoutASessionEndUnauthorizedAndHaveNoEffects() async throws {
        let model = SharedScreenModelFactory().makeInvitations()
        let failed = await waitForState(model) { $0.phase == .failure(.unauthorized) }
        XCTAssertNotNil(failed)
        let finished = await finishes(model.effects(), within: 5)
        XCTAssertTrue(finished)
        model.send(.showTab(.answered))
        let shown = await waitForState(model) { $0.tab == .answered }
        XCTAssertNotNil(shown)
    }

    @MainActor
    func testReleasingTheInvitationsBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedInvitationsScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeInvitations() as? SharedInvitationsScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        model = nil
        XCTAssertTrue(lease.isClosed)
    }

    // MARK: - New item
    @MainActor
    func testTheNewItemFormOpensOnTheGivenDayAndAFormThatCannotWorkFails() async {
        let model = SharedScreenModelFactory().makeNewItem(day: "2026-10-17")
        XCTAssertEqual(model.state.defaultDay, "2026-10-17")
        let editing = await waitForState(model) { $0.phase == .editing }
        XCTAssertNotNil(editing)
        let draft = NewItemDraft(
            kind: .event, title: " ", day: "2026-10-17", timed: false, startMinutes: 0, hasEnd: false,
            endMinutes: 0, place: "", calendarId: ""
        )
        model.send(.create(draft))
        let failed = await waitForState(model) { $0.phase == .failed(.rejected) }
        XCTAssertNotNil(failed)
        model.send(.edited)
        let again = await waitForState(model) { $0.phase == .editing }
        XCTAssertNotNil(again)
    }

    @MainActor
    func testReleasingTheNewItemBridgeClosesTheKotlinViewModel() async throws {
        var model: SharedNewItemScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeNewItem(day: "2026-10-17") as? SharedNewItemScreenModel
        )
        let lease = try XCTUnwrap(model?.lease)
        let effects = try XCTUnwrap(model?.effects())
        model = nil
        XCTAssertTrue(lease.isClosed)
        let finished = await finishes(effects, within: 5)
        XCTAssertTrue(finished)
    }
}

// MARK: - Helpers
private extension SharedCalendarScreenModelTests {

    /// The first state of `model` that matches `predicate`, or `nil` when none arrives within `timeout` seconds.
    @MainActor
    func waitForState<Model: ScreenModel>(
        _ model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Received<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.values.append(state)
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: timeout)
        observer.cancel()
        return found.values.first
    }

    /// The effects one new observer receives until it has `count` of them, or until `timeout` seconds pass.
    @MainActor
    func effects<Model: ScreenModel>(of model: Model, count: Int, timeout: TimeInterval = 5) async -> [Model.Effect] {
        let received = Received<Model.Effect>()
        let complete = XCTestExpectation(description: "\(count) effects arrived")
        let observer = Task { @MainActor in
            for await effect in model.effects() {
                received.values.append(effect)
                if received.values.count == count {
                    complete.fulfill()
                    return
                }
            }
        }
        _ = await XCTWaiter.fulfillment(of: [complete], timeout: timeout)
        observer.cancel()
        return received.values
    }

    /// `true` when `stream` finishes by itself within `timeout` seconds.
    @MainActor
    func finishes<Element>(_ stream: AsyncStream<Element>, within timeout: TimeInterval) async -> Bool {
        let finished = XCTestExpectation(description: "The stream finished")
        let iteration = Task { @MainActor in
            for await _ in stream {}
            finished.fulfill()
        }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: timeout)
        iteration.cancel()
        return result == .completed
    }
}

/// Values a test task received on the main actor.
@MainActor
private final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
