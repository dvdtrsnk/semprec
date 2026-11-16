import CoreKit
import XCTest

@testable import OverviewFeature

final class OverviewViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedOverviewScreenModel(state: .loading)
        let viewModel = OverviewViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state, .loading)
        let observer = observing(viewModel)
        defer { observer.cancel() }
        let content = OverviewContent(inboxPending: 9)
        model.publish(.content(content))
        try await eventually { viewModel.state == .content(content) }
        model.publish(.failure(.unavailable))
        try await eventually { viewModel.state == .failure(.unavailable) }
        XCTAssertEqual(viewModel.state, .failure(.unavailable))
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedOverviewScreenModel(state: .loading)
        let viewModel = OverviewViewModel(model: model, router: RouterSpy())
        viewModel.retry()
        viewModel.open(.tasks)
        viewModel.open(.area(id: "work"))
        XCTAssertEqual(model.actions, [.retry, .open(.tasks), .open(.area(id: "work"))])
    }

    @MainActor
    func testEveryTargetTheModelRaisesReachesTheRouterOnce() async throws {
        let router = RouterSpy()
        let model = ScriptedOverviewScreenModel(state: .loading)
        let viewModel = OverviewViewModel(model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.inbox)
        let observer = observing(viewModel)
        defer { observer.cancel() }
        model.emit(.journal(itemId: "j1"))
        model.emit(.collection(ownerModuleId: "events", databaseId: "d1"))
        try await eventually { router.targets.count == 3 }
        XCTAssertEqual(
            router.targets,
            [.inbox, .journal(itemId: "j1"), .collection(ownerModuleId: "events", databaseId: "d1")]
        )
    }

    @MainActor
    func testRefreshAsksForAReloadAndReturnsOnceTheContentIsNotRefreshingAnymore() async throws {
        let model = ScriptedOverviewScreenModel(state: .content(OverviewContent(refreshing: true)))
        let viewModel = OverviewViewModel(model: model, router: RouterSpy())
        let finished = Received<Bool>()
        let refresh = Task { @MainActor in
            await viewModel.refresh()
            finished.values.append(true)
        }
        defer { refresh.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.actions, [.refresh])
        XCTAssertEqual(finished.values, [], "A pull to refresh lasts while the content refreshes")
        model.publish(.content(OverviewContent(refreshing: false, inboxPending: 1)))
        try await eventually { finished.values == [true] }
        XCTAssertEqual(finished.values, [true])
    }

    @MainActor
    func testRefreshOfContentThatIsNotRefreshingReturnsAtOnce() async {
        let model = ScriptedOverviewScreenModel(state: .failure(.unavailable))
        let viewModel = OverviewViewModel(model: model, router: RouterSpy())
        await viewModel.refresh()
        XCTAssertEqual(model.actions, [.refresh])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedOverviewScreenModel?
        var viewModel: OverviewViewModel?
        do {
            let model = ScriptedOverviewScreenModel(state: .loading)
            weakModel = model
            viewModel = OverviewViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Helpers
    @MainActor
    private func observing(_ viewModel: OverviewViewModel) -> Task<Void, Never> {
        Task { await viewModel.observe() }
    }

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
/// Values a test task received on the main actor.
@MainActor
final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}

@MainActor
final class RouterSpy: OverviewRouting {

    // MARK: - Properties
    private(set) var targets: [OverviewTarget] = []
    private(set) var results: [SearchResultLink] = []

    // MARK: - Protocol conformance
    func show(_ target: OverviewTarget) {
        targets.append(target)
    }

    func showSearchResult(_ link: SearchResultLink) {
        results.append(link)
    }
}
