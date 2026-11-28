import CoreKit
import XCTest

@testable import InboxFeature

final class InboxViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedInboxScreenModel(state: .loading)
        let viewModel = InboxViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        let content = InboxContent(cards: [InboxCard(id: "a", type: .task)], handled: 2)
        model.publish(.content(content))
        try await eventually { viewModel.state == .content(content) }
        model.publish(.failure(.unavailable))
        try await eventually { viewModel.state == .failure(.unavailable) }
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedInboxScreenModel(state: .content(InboxContent()))
        let viewModel = InboxViewModel(model: model, router: RouterSpy())
        let actions: [InboxAction] = [
            .retry, .refresh, .setText(cardId: "a", key: "name", text: "x"),
            .setFlag(cardId: "a", key: "allDay", value: true),
            .setDate(cardId: "a", key: "date", date: "2026-10-17"), .setTime(cardId: "a", key: "date", time: "09:00"),
            .pick(cardId: "a", key: "project", choiceId: nil), .toggle(cardId: "a", key: "people", choiceId: "p"),
            .openPicker(cardId: "a", key: "project"), .closePicker, .setSecret(cardId: "a", text: "sk"), .approve,
            .reject, .undo, .reset(cardId: "a"), .recompute(cardId: "a"), .openResult, .dismissResult, .dismissProblem,
            .openAttachment(cardId: "a", attachmentId: "f1"), .closeAttachment
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    @MainActor
    func testTheOpenItemEffectReachesTheRouter() async throws {
        let model = ScriptedInboxScreenModel(state: .content(InboxContent()))
        let router = RouterSpy()
        let viewModel = InboxViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openItem(databaseKey: "tasks", itemId: "t7"))
        try await eventually { !router.shown.isEmpty }
        XCTAssertEqual(router.shown, ["tasks/t7"])
    }

    @MainActor
    func testEffectsRaisedBeforeObservationAreRoutedOnceItStarts() async throws {
        let router = RouterSpy()
        let model = ScriptedInboxScreenModel(
            state: .content(InboxContent()),
            effects: [.openItem(databaseKey: nil, itemId: "t1"), .openItem(databaseKey: "files", itemId: "f2")]
        )
        let viewModel = InboxViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.shown.count == 2 }
        XCTAssertEqual(router.shown, ["-/t1", "files/f2"])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedInboxScreenModel?
        var viewModel: InboxViewModel?
        do {
            let model = ScriptedInboxScreenModel(state: .loading)
            weakModel = model
            viewModel = InboxViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}

// MARK: - Spies
@MainActor
private final class RouterSpy: InboxRouting {

    // MARK: - Properties
    private(set) var shown: [String] = []

    // MARK: - InboxRouting
    func showItem(databaseKey: String?, itemId: String) {
        shown.append("\(databaseKey ?? "-")/\(itemId)")
    }
}
