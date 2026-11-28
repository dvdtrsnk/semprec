import CoreKit
import XCTest

@testable import Alldots

final class WakeGuardViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedWakeGuardScreenModel(state: WakeGuardState())
        let viewModel = WakeGuardViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .idle)
        let observer = Task { await viewModel.observe() }

        model.publish(WakeGuardState(phase: .scanning, codeCount: 2))
        try await eventually { viewModel.state.phase == .scanning }
        XCTAssertEqual(viewModel.state.codeCount, 2)

        model.publish(WakeGuardState(phase: .tapping, tapsLeft: 150))
        try await eventually { viewModel.state.tapsLeft == 150 }
        XCTAssertEqual(viewModel.state.phase, .tapping)
        observer.cancel()
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedWakeGuardScreenModel(state: WakeGuardState())
        let viewModel = WakeGuardViewModel(model: model)

        viewModel.send(.codeScanned("123"))
        viewModel.send(.tap)
        viewModel.send(.openTapFallback)
        viewModel.send(.backToScanning)

        XCTAssertEqual(model.actions, [.codeScanned("123"), .tap, .openTapFallback, .backToScanning])
    }

    @MainActor
    func testTheEffectsAreCountedWhenTheyAreObservedAndWaitWhenNobodyObserves() async throws {
        let model = ScriptedWakeGuardScreenModel(state: WakeGuardState(), effects: [.codeRejected])
        let viewModel = WakeGuardViewModel(model: model)
        XCTAssertEqual(viewModel.rejections, 0)
        let observer = Task { await viewModel.observe() }

        try await eventually { viewModel.rejections == 1 }
        model.emit(.codeRejected)
        model.emit(.finished)
        try await eventually { viewModel.rejections == 2 && viewModel.finishes == 1 }

        XCTAssertEqual(viewModel.rejections, 2)
        XCTAssertEqual(viewModel.finishes, 1)
        observer.cancel()
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedWakeGuardScreenModel?
        autoreleasepool {
            let model = ScriptedWakeGuardScreenModel(state: WakeGuardState())
            weakModel = model
            let viewModel = WakeGuardViewModel(model: model)
            withExtendedLifetime(viewModel) {}
        }
        XCTAssertNil(weakModel, "The view model must own the only reference to its model")
    }
}
