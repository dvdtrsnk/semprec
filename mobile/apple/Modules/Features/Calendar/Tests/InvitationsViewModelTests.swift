import CoreKit
import XCTest

@testable import CalendarFeature

final class InvitationsViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedInvitationsScreenModel(state: InvitationsState(phase: .loading))
        let viewModel = InvitationsViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(.previewPending)
        try await eventually { viewModel.state.phase == .content }
        XCTAssertEqual(viewModel.state, .previewPending)
        model.publish(InvitationsState(phase: .failure(nil)))
        try await eventually { viewModel.state.phase == .failure(nil) }
        XCTAssertEqual(viewModel.state.phase, .failure(nil))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedInvitationsScreenModel(state: .previewPending)
        let viewModel = InvitationsViewModel(model: model)
        viewModel.retry()
        viewModel.send(.showTab(.answered))
        viewModel.send(.answer(invitationId: "i1", reply: .accept))
        viewModel.send(.answer(invitationId: "i2", reply: .tentative))
        viewModel.send(.answer(invitationId: "i2", reply: .decline))
        viewModel.send(.answer(invitationId: "i3", reply: .acknowledge))
        viewModel.send(.dismissProblem)
        XCTAssertEqual(model.actions, [
            .retry,
            .showTab(.answered),
            .answer(invitationId: "i1", reply: .accept),
            .answer(invitationId: "i2", reply: .tentative),
            .answer(invitationId: "i2", reply: .decline),
            .answer(invitationId: "i3", reply: .acknowledge),
            .dismissProblem
        ])
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedInvitationsScreenModel?
        var viewModel: InvitationsViewModel?
        do {
            let model = ScriptedInvitationsScreenModel(state: .previewPending)
            weakModel = model
            viewModel = InvitationsViewModel(model: model)
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
