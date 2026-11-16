import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarViewModelTests: XCTestCase {

    // MARK: - Properties
    private var loading: CalendarState {
        CalendarState(phase: .loading, selectedDay: "2026-10-16", today: "2026-10-16")
    }

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedCalendarScreenModel(state: loading)
        let viewModel = CalendarViewModel(model: model, router: CalendarRouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(CalendarState(phase: .content, selectedDay: "2026-10-16", today: "2026-10-16"))
        try await eventually { viewModel.state.phase == .content }
        XCTAssertEqual(viewModel.state.phase, .content)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModelInItsGroup() {
        let model = ScriptedCalendarScreenModel(state: loading)
        let router = CalendarRouterSpy()
        let viewModel = CalendarViewModel(model: model, router: router)
        viewModel.navigate(.goToday)
        viewModel.gesture(.tap(itemId: "e1"))
        viewModel.edit(.cut(itemId: "e1"))
        viewModel.open(.calendars)
        viewModel.send(.navigation(.retry))
        XCTAssertEqual(model.actions, [
            .navigation(.goToday),
            .gesture(.tap(itemId: "e1")),
            .edit(.cut(itemId: "e1")),
            .open(.calendars),
            .navigation(.retry)
        ])
        XCTAssertTrue(router.calls.isEmpty, "Only an effect of the shared ViewModel navigates")
    }

    @MainActor
    func testEffectsBecomeRouterCallsIncludingOnesRaisedBeforeObservation() async throws {
        let model = ScriptedCalendarScreenModel(
            state: loading,
            effects: [.openDetails(itemId: "e1", kind: .task, day: "2026-10-16")]
        )
        let router = CalendarRouterSpy()
        let viewModel = CalendarViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        model.emit(.openCalendars)
        model.emit(.openInvitations)
        model.emit(.openNewItem(day: "2026-10-17"))
        model.emit(.openSleep(night: "2026-10-16"))
        model.emit(.openAgenda(day: "2026-10-16"))
        try await eventually { router.calls.count == 6 }
        XCTAssertEqual(
            router.calls,
            [
                "details e1 task 2026-10-16", "calendars", "invitations", "newItem 2026-10-17",
                "sleepNight 2026-10-16", "agenda 2026-10-16"
            ]
        )
        observer.cancel()
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedCalendarScreenModel?
        var viewModel: CalendarViewModel?
        autoreleasepool {
            let model = ScriptedCalendarScreenModel(state: loading)
            weakModel = model
            viewModel = CalendarViewModel(model: model, router: CalendarRouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}

// MARK: - Spies
@MainActor
final class CalendarRouterSpy {

    // MARK: - Properties
    /// What the router was asked, as `details <id> <kind> <day>`, `calendars`, `invitations`, `newItem <day>`,
    /// `sleepNight <night>` or `sleepPlan`.
    var calls: [String] = []
}

// MARK: - Protocol conformance
extension CalendarRouterSpy: CalendarRouting {

    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {
        calls.append("details \(itemId) \(kind) \(day)")
    }

    func showCalendars() {
        calls.append("calendars")
    }

    func showInvitations() {
        calls.append("invitations")
    }

    func showNewItem(day: String) {
        calls.append("newItem \(day)")
    }

    func showSleepNight(night: String) {
        calls.append("sleepNight \(night)")
    }

    func showSleepPlan() {
        calls.append("sleepPlan")
    }

    func showAgenda(from day: String) {
        calls.append("agenda \(day)")
    }
}
