import CoreKit
import XCTest

@testable import HomeFeature

final class DetailViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateRepublishesChangesAndForwardsRetry() async throws {
        let item = PlaceholderItem(id: "item-1", ordinal: 1)
        let model = ScriptedDetailScreenModel(state: .loading)
        let viewModel = DetailViewModel(model: model)
        XCTAssertEqual(viewModel.state, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(.content(item))
        try await eventually { viewModel.state == .content(item) }
        model.publish(.notFound)
        try await eventually { viewModel.state == .notFound }
        XCTAssertEqual(viewModel.state, .notFound)
        viewModel.retry()
        XCTAssertEqual(model.actions, [.retry])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}
