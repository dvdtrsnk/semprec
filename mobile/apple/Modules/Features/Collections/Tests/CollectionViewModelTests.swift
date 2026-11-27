import CoreKit
import XCTest

@testable import CollectionsFeature

final class CollectionViewModelTests: XCTestCase {

    // MARK: - Properties
    private let loaded = CollectionState(
        phase: .content,
        header: CollectionHeader(
            databaseId: "db", key: "projects", name: "Projects", icon: nil, color: nil, searchPlaceholder: nil
        )
    )

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedCollectionScreenModel(state: CollectionState())
        let viewModel = CollectionViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(loaded)
        try await eventually { viewModel.state == self.loaded }
        XCTAssertEqual(viewModel.state, loaded)
        let failed = CollectionState(phase: .error, failure: .unavailable)
        model.publish(failed)
        try await eventually { viewModel.state == failed }
        XCTAssertEqual(viewModel.state, failed)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedAndNothingIsRoutedWithoutAnEffect() {
        let model = ScriptedCollectionScreenModel(state: loaded)
        let router = RouterSpy()
        let viewModel = CollectionViewModel(model: model, router: router)
        viewModel.send(.search("web"))
        viewModel.send(.filter(.open))
        viewModel.send(.write(.create(title: "New")))
        XCTAssertEqual(model.actions, [.search("web"), .filter(.open), .write(.create(title: "New"))])
        XCTAssertTrue(router.items.isEmpty && router.events.isEmpty)
    }

    @MainActor
    func testAChipOfTheFacetBarTogglesItsValueInTheFilterSheetsSelection() {
        let bar = FacetBar(
            propertyKey: "tags",
            chips: [
                FilterOption(value: "client", label: "Client", color: "#FF9500", count: 3, selected: false),
                FilterOption(value: "home", label: "Home", color: nil, count: 1, selected: true)
            ]
        )
        var state = loaded
        state.facetBar = bar
        let model = ScriptedCollectionScreenModel(state: state)
        let viewModel = CollectionViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.facetBar, bar)
        for chip in bar.chips {
            viewModel.send(CollectionFacetBarView.toggle(chip, of: bar))
        }
        XCTAssertEqual(
            model.actions,
            [
                .filter(.toggle(propertyKey: "tags", value: "client")),
                .filter(.toggle(propertyKey: "tags", value: "home"))
            ]
        )
    }

    @MainActor
    func testOpenItemEffectsBecomeRouterCallsIncludingOnesRaisedBeforeObservation() async throws {
        let model = ScriptedCollectionScreenModel(
            state: loaded,
            effects: [.openItem(itemId: "p1", databaseKey: "projects"), .openItem(itemId: "x", databaseKey: nil)]
        )
        let router = RouterSpy()
        let viewModel = CollectionViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        try await eventually { router.items.count == 2 }
        XCTAssertEqual(router.items, ["p1:projects", "x:-"])
        model.emit(.openItem(itemId: "p2", databaseKey: "people"))
        try await eventually { router.items.count == 3 }
        XCTAssertEqual(router.items.last, "p2:people")
        observer.cancel()
    }

    @MainActor
    func testAnEventOpensTheSharedEventSheetInsteadOfTheGenericItem() async throws {
        let model = ScriptedCollectionScreenModel(
            state: loaded,
            effects: [.openItem(itemId: "e1", databaseKey: "events")]
        )
        let router = RouterSpy()
        let viewModel = CollectionViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        try await eventually { !router.events.isEmpty }
        XCTAssertEqual(router.events, ["e1"])
        XCTAssertTrue(router.items.isEmpty)
        observer.cancel()
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: AnyObject?
        var viewModel: CollectionViewModel?
        do {
            let model = ScriptedCollectionScreenModel(state: loaded)
            weakModel = model
            viewModel = CollectionViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        XCTAssertNotNil(viewModel)
        viewModel = nil
        XCTAssertNil(weakModel)
    }
}
