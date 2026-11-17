import CoreKit
import XCTest

@testable import OverviewFeature

final class SearchViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedSearchScreenModel(state: SearchState(recents: ["faktura"]))
        let viewModel = SearchViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.recents, ["faktura"])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(SearchState(phase: .searching, scope: .task))
        try await eventually { viewModel.state.phase == .searching }
        XCTAssertEqual(viewModel.state.scope, .task)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedSearchScreenModel(state: SearchState())
        let viewModel = SearchViewModel(model: model, router: RouterSpy())
        let result = SearchResult(
            key: "t1",
            itemId: "t1",
            threadId: nil,
            databaseKey: "tasks",
            title: "Invoice",
            subtitle: [],
            snippet: nil,
            journalType: nil,
            journalPeriod: nil
        )
        viewModel.queryChanged("fakt")
        viewModel.selectScope(.mail)
        viewModel.selectScope(nil)
        viewModel.submit("fakt")
        viewModel.retry()
        viewModel.open(result, in: .task)
        XCTAssertEqual(
            model.actions,
            [
                .queryChanged("fakt"),
                .selectScope(.mail),
                .selectScope(nil),
                .submit("fakt"),
                .retry,
                .open(type: .task, key: "t1")
            ]
        )
    }

    @MainActor
    func testAnOpenedResultReachesTheRouterAsALink() async throws {
        let router = RouterSpy()
        let model = ScriptedSearchScreenModel(state: SearchState())
        let viewModel = SearchViewModel(model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(
            .openResult(
                type: .journal,
                itemId: "j1",
                threadId: nil,
                databaseKey: "journal",
                journalType: "day",
                journalPeriod: "2026-10-16"
            )
        )
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.results.count == 1 }
        XCTAssertEqual(
            router.results,
            [
                SearchResultLink(
                    type: .journal,
                    itemId: "j1",
                    threadId: nil,
                    databaseKey: "journal",
                    journalType: "day",
                    journalPeriod: "2026-10-16"
                )
            ]
        )
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedSearchScreenModel?
        var viewModel: SearchViewModel?
        do {
            let model = ScriptedSearchScreenModel(state: SearchState())
            weakModel = model
            viewModel = SearchViewModel(model: model, router: RouterSpy())
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
