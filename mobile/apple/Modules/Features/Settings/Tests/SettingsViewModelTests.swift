import CoreKit
import XCTest

@testable import SettingsFeature

final class SettingsViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let initial = SettingsState(rows: [.about])
        let empty = SettingsState(rows: [])
        let model = ScriptedSettingsScreenModel(state: initial)
        let viewModel = SettingsViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state, initial)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        model.publish(empty)
        try await eventually { viewModel.state == empty }
        XCTAssertEqual(viewModel.state, empty)
        // The second update must travel through the active subscription, not the initial snapshot.
        model.publish(initial)
        try await eventually { viewModel.state == initial }
        XCTAssertEqual(viewModel.state, initial)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testSelectingARowIsForwardedAndShowAboutReachesTheRouter() async throws {
        let model = ScriptedSettingsScreenModel(state: SettingsState(rows: [.about]))
        let router = RouterSpy()
        let viewModel = SettingsViewModel(model: model, router: router)
        XCTAssertEqual(viewModel.state, SettingsState(rows: [.about]))
        viewModel.select(.about)
        XCTAssertEqual(model.actions, [.selectRow(.about)])
        XCTAssertEqual(router.aboutCount, 0)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.emit(.showAbout)
        try await eventually { router.aboutCount == 1 }
        XCTAssertEqual(router.aboutCount, 1)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedSettingsScreenModel?
        var viewModel: SettingsViewModel?
        do {
            let model = ScriptedSettingsScreenModel(state: SettingsState(rows: [.about]))
            weakModel = model
            viewModel = SettingsViewModel(model: model, router: RouterSpy())
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
private final class RouterSpy {

    // MARK: - Properties
    var aboutCount = 0
}

// MARK: - Protocol conformance
extension RouterSpy: SettingsRouting {

    func showAbout() {
        aboutCount += 1
    }
}
