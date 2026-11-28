import CoreKit
import XCTest

@testable import SleepFeature

final class WakeSettingsViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedWakeSettingsScreenModel(state: WakeSettingsState())
        let viewModel = WakeSettingsViewModel(model: model)
        XCTAssertEqual(viewModel.state.mode, .off)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }

        let active = WakeSettingsState(requiresCode: true, codes: ["123"], mode: .active)
        model.publish(active)
        try await eventually { viewModel.state == active }
        XCTAssertEqual(viewModel.state, active)

        model.publish(WakeSettingsState(requiresCode: true, mode: .needsCode, failure: .notAuthorized))
        try await eventually { viewModel.state.failure == .notAuthorized }
        XCTAssertEqual(viewModel.state.mode, .needsCode)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedWakeSettingsScreenModel(state: WakeSettingsState())
        let viewModel = WakeSettingsViewModel(model: model)

        viewModel.send(.setRequiresCode(true))
        viewModel.send(.addCode("123"))
        viewModel.send(.removeCode("123"))
        viewModel.send(.dismissFailure)

        XCTAssertEqual(
            model.actions,
            [.setRequiresCode(true), .addCode("123"), .removeCode("123"), .dismissFailure]
        )
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedWakeSettingsScreenModel?
        autoreleasepool {
            let model = ScriptedWakeSettingsScreenModel(state: WakeSettingsState())
            weakModel = model
            let viewModel = WakeSettingsViewModel(model: model)
            withExtendedLifetime(viewModel) {}
        }
        XCTAssertNil(weakModel, "The view model must own the only reference to its model")
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}
