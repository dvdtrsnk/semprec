import CoreKit
import XCTest

@testable import CalendarFeature

final class CalendarListViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedCalendarListScreenModel(state: CalendarListState(phase: .loading))
        let viewModel = CalendarListViewModel(model: model, router: SheetsRouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(.previewList)
        try await eventually { viewModel.state.phase == .content }
        XCTAssertEqual(viewModel.state, .previewList)
        model.publish(CalendarListState(phase: .failure(.unavailable)))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
        XCTAssertEqual(viewModel.state.phase, .failure(.unavailable))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedCalendarListScreenModel(state: .previewList)
        let router = SheetsRouterSpy()
        let viewModel = CalendarListViewModel(model: model, router: router)
        let actions: [CalendarListAction] = [
            .change(.toggleHidden(calendarId: "work")), .setAllHidden(true), .openDetail(calendarId: "work"),
            .closeDetail, .change(.rename(calendarId: "work", name: "Job")),
            .change(.setColor(calendarId: "work", color: "#FF3B30")),
            .change(.setNotify(calendarId: "work", notify: false)),
            .change(.useRemoteColor(calendarId: "family")), .add(name: "New"),
            .requestDelete(calendarId: "work"), .confirmDelete, .cancelDelete, .openSleep, .dismissProblem, .refresh
        ]
        viewModel.retry()
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, [.retry] + actions)
        XCTAssertTrue(router.calls.isEmpty, "Only an effect of the shared ViewModel navigates")
    }

    @MainActor
    func testOpenSleepEffectsOpenTheSleepPlanIncludingOnesRaisedBeforeObservation() async throws {
        let model = ScriptedCalendarListScreenModel(state: .previewList, effects: [.openSleep])
        let router = SheetsRouterSpy()
        let viewModel = CalendarListViewModel(model: model, router: router)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        try await eventually { router.calls.count == 1 }
        model.emit(.openSleep)
        try await eventually { router.calls.count == 2 }
        XCTAssertEqual(router.calls, ["sleepPlan", "sleepPlan"])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedCalendarListScreenModel?
        var viewModel: CalendarListViewModel?
        do {
            let model = ScriptedCalendarListScreenModel(state: .previewList)
            weakModel = model
            viewModel = CalendarListViewModel(model: model, router: SheetsRouterSpy())
        }
        XCTAssertNotNil(viewModel)
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel, "Releasing the ViewModel must release the model, which closes the shared one")
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}

// MARK: - Spies
@MainActor
final class SheetsRouterSpy {

    // MARK: - Properties
    /// What the router was asked, as `sleepPlan`; the calendars sheet requests nothing else.
    var calls: [String] = []
}

// MARK: - Protocol conformance
extension SheetsRouterSpy: CalendarRouting {

    func showDetails(itemId: String, kind: CalendarItemKind, day: String) {
        calls.append("details \(itemId)")
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
