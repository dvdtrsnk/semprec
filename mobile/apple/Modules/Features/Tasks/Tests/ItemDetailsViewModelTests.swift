import CoreKit
import XCTest

@testable import TasksFeature

final class ItemDetailsViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedItemDetailsScreenModel(state: ItemDetailsState(phase: .loading))
        let viewModel = ItemDetailsViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        model.publish(ItemDetailsState(phase: .content, title: "Odeslat fakturu"))
        try await eventually { viewModel.state.title == "Odeslat fakturu" }
        model.publish(ItemDetailsState(phase: .failure(.notFound)))
        try await eventually { viewModel.state.phase == .failure(.notFound) }
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedItemDetailsScreenModel(state: ItemDetailsState(phase: .content))
        let viewModel = ItemDetailsViewModel(model: model)
        let actions: [ItemDetailsAction] = [
            .retry, .dismissNotice, .loadChoices, .setTitle("A"), .toggleDone, .setDescription("B"), .setPlace("C"),
            .setFlagged(true), .setDate("2026-10-16"), .setDate(nil), .setTimed(true), .setEnded(false),
            .setTimeFrom("09:00"), .setTimeTo("10:00"), .setAllDay(true), .setRepeat(.weekly), .selectProject("p1"),
            .selectProject(nil), .togglePerson("u1"), .removeFile("f1"), .unlink(.project), .relink(.people), .delete
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    @MainActor
    func testTheDeletedEffectClosesTheSheetOnce() async throws {
        let model = ScriptedItemDetailsScreenModel(state: ItemDetailsState(phase: .content))
        let viewModel = ItemDetailsViewModel(model: model)
        XCTAssertFalse(viewModel.deleted)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.deleted)
        try await eventually { viewModel.deleted }
        XCTAssertTrue(viewModel.deleted)
    }

    @MainActor
    func testADeletedEffectRaisedBeforeObservationIsStillApplied() async throws {
        let model = ScriptedItemDetailsScreenModel(state: ItemDetailsState(phase: .content), effects: [.deleted])
        let viewModel = ItemDetailsViewModel(model: model)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { viewModel.deleted }
        XCTAssertTrue(viewModel.deleted)
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedItemDetailsScreenModel?
        var viewModel: ItemDetailsViewModel?
        do {
            let model = ScriptedItemDetailsScreenModel(state: ItemDetailsState())
            weakModel = model
            viewModel = ItemDetailsViewModel(model: model)
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
