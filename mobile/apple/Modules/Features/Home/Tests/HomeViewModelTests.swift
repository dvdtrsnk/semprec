import CoreKit
import XCTest

@testable import HomeFeature

final class HomeViewModelTests: XCTestCase {

    // MARK: - Properties
    private let items = [PlaceholderItem(id: "item-1", ordinal: 1), PlaceholderItem(id: "item-2", ordinal: 2)]

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedHomeScreenModel(state: .loading)
        let viewModel = HomeViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(.content(items))
        try await eventually { viewModel.state == .content(self.items) }
        XCTAssertEqual(viewModel.state, .content(items))
        model.publish(.failure(.unavailable))
        try await eventually { viewModel.state == .failure(.unavailable) }
        XCTAssertEqual(viewModel.state, .failure(.unavailable))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedAndNothingIsRoutedWithoutAnEffect() {
        let model = ScriptedHomeScreenModel(state: .content(items))
        let router = RouterSpy()
        let viewModel = HomeViewModel(model: model, router: router)
        viewModel.select(items[1])
        viewModel.retry()
        XCTAssertEqual(model.actions, [.selectItem(id: "item-2"), .retry])
        XCTAssertTrue(router.detailIds.isEmpty)
    }

    @MainActor
    func testOpenDetailEffectsBecomeRouterCallsIncludingOnesRaisedBeforeObservation() async throws {
        let model = ScriptedHomeScreenModel(state: .content(items), effects: [.openDetail(id: "item-2")])
        let router = RouterSpy()
        let viewModel = HomeViewModel(model: model, router: router)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        try await eventually { router.detailIds.count == 1 }
        model.emit(.openDetail(id: "item-1"))
        try await eventually { router.detailIds.count == 2 }
        XCTAssertEqual(router.detailIds, ["item-2", "item-1"])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testAnEffectRaisedWhileTheScreenIsAwayIsRoutedOnceWhenItObservesAgain() async throws {
        let model = ScriptedHomeScreenModel(state: .content(items))
        let router = RouterSpy()
        let viewModel = HomeViewModel(model: model, router: router)
        let firstEnded = expectation(description: "The first observation ended")
        let first = Task {
            await viewModel.observe()
            firstEnded.fulfill()
        }
        model.emit(.openDetail(id: "item-1"))
        try await eventually { router.detailIds.count == 1 }
        first.cancel()
        await fulfillment(of: [firstEnded], timeout: 5)
        model.emit(.openDetail(id: "item-2"))
        let secondEnded = expectation(description: "The second observation ended")
        let second = Task {
            await viewModel.observe()
            secondEnded.fulfill()
        }
        try await eventually { router.detailIds.count == 2 }
        second.cancel()
        await fulfillment(of: [secondEnded], timeout: 5)
        XCTAssertEqual(router.detailIds, ["item-1", "item-2"])
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedHomeScreenModel?
        var viewModel: HomeViewModel?
        do {
            let model = ScriptedHomeScreenModel(state: .empty)
            weakModel = model
            viewModel = HomeViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(viewModel)
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel, "Releasing the ViewModel must release the model, which closes the shared one")
    }

    @MainActor
    func testItemTitleIsNumberedByTheOrdinal() throws {
        XCTAssertEqual(PlaceholderItem(id: "item-3", ordinal: 3).title, "Placeholder item 3")
        let czechPath = try XCTUnwrap(Bundle.module.path(forResource: "cs", ofType: "lproj"))
        let czech = try XCTUnwrap(Bundle(path: czechPath))
        let czechFormat = czech.localizedString(forKey: "home.item.title", value: nil, table: nil)
        XCTAssertEqual(czechFormat, "Zástupná položka %lld")
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
    var detailIds: [String] = []
}

// MARK: - Protocol conformance
extension RouterSpy: HomeRouting {

    func showDetail(itemId: String) {
        detailIds.append(itemId)
    }
}
