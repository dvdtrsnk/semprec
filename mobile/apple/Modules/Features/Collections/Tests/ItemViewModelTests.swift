import CoreKit
import XCTest

@testable import CollectionsFeature

final class ItemViewModelTests: XCTestCase {

    // MARK: - Properties
    private func state(databaseKey: String?) -> ItemState {
        ItemState(
            phase: .content,
            header: ItemHeader(
                itemId: "i1",
                databaseId: "db",
                databaseKey: databaseKey,
                databaseName: "Name",
                icon: nil,
                color: nil,
                title: "T"
            )
        )
    }

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedItemScreenModel(state: ItemState())
        let viewModel = ItemViewModel(itemId: "i1", model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        let next = state(databaseKey: "projects")
        model.publish(next)
        try await eventually { viewModel.state == next }
        XCTAssertEqual(viewModel.state, next)
        observer.cancel()
    }

    @MainActor
    func testIntentsAreForwarded() {
        let model = ScriptedItemScreenModel(state: state(databaseKey: "people"))
        let viewModel = ItemViewModel(itemId: "i1", model: model, router: RouterSpy())
        viewModel.send(.edit(.rename("New")))
        viewModel.send(.picker(.choose(targetId: "a")))
        viewModel.send(.deletion(.request))
        XCTAssertEqual(model.actions, [.edit(.rename("New")), .picker(.choose(targetId: "a")), .deletion(.request)])
    }

    @MainActor
    func testANewTagOfTheProjectSettingsIsSentAsANewChoiceOfTheTags() {
        let model = ScriptedItemScreenModel(state: state(databaseKey: "projects"))
        let viewModel = ItemViewModel(itemId: "i1", model: model, router: RouterSpy())
        let tags = FieldView(
            propertyKey: "tags",
            name: "Tags",
            kind: .multiSelect,
            content: .choices([FieldOption(key: "home", label: "Home", color: nil)]),
            options: [FieldOption(key: "home", label: "Home", color: nil)],
            editable: true,
            origin: nil
        )
        viewModel.send(ProjectSettingsSheet.newChoice("Client", of: tags))
        XCTAssertEqual(model.actions, [.edit(.addChoice(propertyKey: "tags", label: "Client"))])
    }

    @MainActor
    func testTheTypedTagIsClearedOnlyOnceTheProjectGainedATag() {
        XCTAssertTrue(ProjectSettingsSheet.gainedTag(before: ["home"], now: ["home", "client"]))
        XCTAssertFalse(ProjectSettingsSheet.gainedTag(before: ["home"], now: ["home"]))
        XCTAssertFalse(ProjectSettingsSheet.gainedTag(before: nil, now: ["home", "client"]))
    }

    @MainActor
    func testANewTagIsSentOnlyWithANameAndNoRunningWrite() {
        XCTAssertTrue(ProjectSettingsSheet.canAddTag(named: "Client", saving: false))
        XCTAssertFalse(ProjectSettingsSheet.canAddTag(named: "Client", saving: true))
        XCTAssertFalse(ProjectSettingsSheet.canAddTag(named: "", saving: false))
        XCTAssertFalse(ProjectSettingsSheet.canAddTag(named: "  ", saving: false))
    }

    @MainActor
    func testOpenItemEffectsGoToTheScreenOfTheirKind() async throws {
        let model = ScriptedItemScreenModel(
            state: state(databaseKey: "projects"),
            effects: [
                .openItem(itemId: "e1", databaseKey: "events"),
                .openItem(itemId: "c1", databaseKey: "companies"),
                .openItem(itemId: "u1", databaseKey: nil)
            ]
        )
        let router = RouterSpy()
        let observer = Task { await ItemViewModel(itemId: "i1", model: model, router: router).observe() }
        try await eventually { router.items.count == 2 }
        XCTAssertEqual(router.events, ["e1"])
        XCTAssertEqual(router.items, ["c1:companies", "u1:-"])
        observer.cancel()
    }

    @MainActor
    func testARelatedCollectionOfAProjectRoutesTasksAndMailToTheirFeaturesAndOthersToACollection() async throws {
        let model = ScriptedItemScreenModel(
            state: state(databaseKey: "projects"),
            effects: [
                .openCollection(databaseId: "t", databaseKey: "tasks", filterJson: "{}"),
                .openCollection(databaseId: "m", databaseKey: "threads", filterJson: nil),
                .openCollection(databaseId: "f", databaseKey: "files", filterJson: "{\"a\":1}"),
                .openCollection(databaseId: "x", databaseKey: "files", filterJson: nil),
                .close
            ]
        )
        let router = RouterSpy()
        let observer = Task { await ItemViewModel(itemId: "p1", model: model, router: router).observe() }
        try await eventually { !router.collections.isEmpty }
        XCTAssertEqual(router.tasks, ["p1"])
        XCTAssertEqual(router.mail, ["p1"])
        XCTAssertEqual(router.collections, [.matching(databaseKey: "files", databaseId: "f", filterJson: "{\"a\":1}")])
        observer.cancel()
    }

    @MainActor
    func testTheTasksOfSomethingThatIsNotAProjectOpenAsACollectionAndAThreadWithoutAFilterIsDropped() async throws {
        let model = ScriptedItemScreenModel(
            state: state(databaseKey: "people"),
            effects: [
                .openCollection(databaseId: "t", databaseKey: "tasks", filterJson: "{}"),
                .openCollection(databaseId: "m", databaseKey: "threads", filterJson: nil)
            ]
        )
        let router = RouterSpy()
        let observer = Task { await ItemViewModel(itemId: "x", model: model, router: router).observe() }
        try await eventually { !router.collections.isEmpty }
        XCTAssertEqual(router.collections, [.matching(databaseKey: "tasks", databaseId: "t", filterJson: "{}")])
        XCTAssertTrue(router.tasks.isEmpty && router.mail.isEmpty)
        observer.cancel()
    }

    @MainActor
    func testTheRowsOfAProjectReachTheScreensOfOtherFeaturesAndItsFiles() {
        let router = RouterSpy()
        let viewModel = ItemViewModel(
            itemId: "p1", model: ScriptedItemScreenModel(state: state(databaseKey: "projects")), router: router
        )
        viewModel.showProject(.tasks)
        viewModel.showProject(.mail)
        viewModel.showProject(.mailSignals)
        viewModel.showProject(.notes)
        viewModel.showProject(.agent)
        viewModel.showProject(.files)
        viewModel.showProject(.tags)
        viewModel.showProject(.tag(key: "client"))
        XCTAssertEqual(router.tasks, ["p1"])
        XCTAssertEqual(router.mail, ["p1"])
        XCTAssertEqual(router.mailSignals, ["p1"])
        XCTAssertEqual(router.notes, ["p1"])
        XCTAssertEqual(router.agents, ["p1"])
        XCTAssertEqual(router.collections, [.ofItem(databaseKey: "files", relationKey: "projects", itemId: "p1")])
        XCTAssertEqual(router.projectTags, ["p1"])
        XCTAssertEqual(router.projectTag, ["p1:client"])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: AnyObject?
        var viewModel: ItemViewModel?
        do {
            let model = ScriptedItemScreenModel(state: ItemState())
            weakModel = model
            viewModel = ItemViewModel(itemId: "i1", model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        XCTAssertNotNil(viewModel)
        viewModel = nil
        XCTAssertNil(weakModel)
    }
}
