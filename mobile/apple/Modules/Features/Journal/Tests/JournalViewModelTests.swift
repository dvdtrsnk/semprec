import CoreKit
import XCTest

@testable import JournalFeature

final class JournalViewModelTests: XCTestCase {

    // MARK: - Properties
    private let selection = JournalSelection(kind: .day, start: "2026-10-16")

    private var loading: JournalState {
        JournalState(phase: .loading, selection: selection, today: "2026-10-16")
    }

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedJournalScreenModel(state: loading)
        let viewModel = JournalViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(JournalState(phase: .content, selection: selection, today: "2026-10-16"))
        try await eventually { viewModel.state.phase == .content }
        XCTAssertEqual(viewModel.state.phase, .content)
        model.publish(JournalState(phase: .failure(.unavailable), selection: selection, today: "2026-10-16"))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
        XCTAssertEqual(viewModel.state.phase, .failure(.unavailable))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedJournalScreenModel(state: loading)
        let router = RouterSpy()
        let viewModel = JournalViewModel(model: model, router: router)
        let cell = JournalAxisCell(
            kind: .month, start: "2026-10-01", year: 2026, quarter: 4, month: 10, day: 1, weekday: 4,
            onPath: true, current: false, today: false
        )
        viewModel.retry()
        viewModel.select(cell)
        viewModel.goToday()
        viewModel.showAxis(around: "2029-03-10")
        viewModel.openEvent(JournalEvent(id: "e1", title: "Standup"))
        viewModel.openInbox()
        XCTAssertEqual(model.actions, [
            .retry,
            .select(kind: .month, start: "2026-10-01"),
            .goToday,
            .showAxisAround(day: "2029-03-10"),
            .openEvent(id: "e1"),
            .openInbox
        ])
        XCTAssertTrue(router.calls.isEmpty, "Only an effect of the shared ViewModel navigates")
    }

    @MainActor
    func testATurnSelectsThePeriodOfTheSameKindThatManyStepsAwayAndNamesIt() {
        let model = ScriptedJournalScreenModel(state: JournalState(
            phase: .content, selection: JournalSelection(kind: .month, start: "2026-12-01"), today: "2026-10-16"
        ))
        let viewModel = JournalViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.turn(by: 1), JournalSelection(kind: .month, start: "2027-01-01"))
        XCTAssertEqual(viewModel.turn(by: -2), JournalSelection(kind: .month, start: "2026-10-01"))
        XCTAssertEqual(model.actions, [
            .select(kind: .month, start: "2027-01-01"),
            .select(kind: .month, start: "2026-10-01")
        ])
    }

    @MainActor
    func testATurnFromASelectionThatIsNoDaySelectsNothing() {
        let model = ScriptedJournalScreenModel(state: JournalState(
            phase: .content, selection: JournalSelection(kind: .day, start: "not a day"), today: "2026-10-16"
        ))
        let viewModel = JournalViewModel(model: model, router: RouterSpy())
        XCTAssertNil(viewModel.turn(by: 1))
        XCTAssertTrue(model.actions.isEmpty)
    }

    @MainActor
    func testSelectingByKindAndStartIsForwardedAsASelection() {
        let model = ScriptedJournalScreenModel(state: loading)
        let viewModel = JournalViewModel(model: model, router: RouterSpy())
        viewModel.select(kind: .year, start: "2027-01-01")
        XCTAssertEqual(model.actions, [.select(kind: .year, start: "2027-01-01")])
    }

    @MainActor
    func testEffectsBecomeRouterCallsIncludingOnesRaisedBeforeObservation() async throws {
        let model = ScriptedJournalScreenModel(state: loading, effects: [.openEvent(id: "e1")])
        let router = RouterSpy()
        let viewModel = JournalViewModel(model: model, router: router)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        try await eventually { router.calls.count == 1 }
        model.emit(.openInbox)
        try await eventually { router.calls.count == 2 }
        XCTAssertEqual(router.calls, ["event e1", "inbox"])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testAnEffectRaisedWhileTheScreenIsAwayIsRoutedOnceWhenItObservesAgain() async throws {
        let model = ScriptedJournalScreenModel(state: loading)
        let router = RouterSpy()
        let viewModel = JournalViewModel(model: model, router: router)
        let firstEnded = expectation(description: "The first observation ended")
        let first = Task {
            await viewModel.observe()
            firstEnded.fulfill()
        }
        model.emit(.openInbox)
        try await eventually { router.calls.count == 1 }
        first.cancel()
        await fulfillment(of: [firstEnded], timeout: 5)
        model.emit(.openEvent(id: "e2"))
        let secondEnded = expectation(description: "The second observation ended")
        let second = Task {
            await viewModel.observe()
            secondEnded.fulfill()
        }
        try await eventually { router.calls.count == 2 }
        second.cancel()
        await fulfillment(of: [secondEnded], timeout: 5)
        XCTAssertEqual(router.calls, ["inbox", "event e2"])
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedJournalScreenModel?
        var viewModel: JournalViewModel?
        do {
            let model = ScriptedJournalScreenModel(state: loading)
            weakModel = model
            viewModel = JournalViewModel(model: model, router: RouterSpy())
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
final class RouterSpy {

    // MARK: - Properties
    /// What the router was asked, as `event <id>`, `inbox` or `page <id> <title>`.
    var calls: [String] = []
}

// MARK: - Protocol conformance
extension RouterSpy: JournalRouting {

    func showEvent(id: String) {
        calls.append("event \(id)")
    }

    func showInbox() {
        calls.append("inbox")
    }

    func showPage(itemId: String, title: String) {
        calls.append("page \(itemId) \(title)")
    }
}
