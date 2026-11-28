import CoreKit
import XCTest

@testable import CollectionsFeature

/// The intents of the tag management pages of the project settings and the names of the colours a tag can take.
final class ProjectTagPageTests: XCTestCase {

    // MARK: - Properties
    private let client = FieldOption(key: "client", label: "Client", color: "#FF9500")

    private var tags: FieldView {
        FieldView(
            propertyKey: "tags",
            name: "Tags",
            kind: .multiSelect,
            content: .choices([client]),
            options: [client, FieldOption(key: "home", label: "Home", color: nil)],
            editable: true,
            origin: nil
        )
    }

    // MARK: - Tests
    @MainActor
    func testRenamingSendsTheTrimmedNameOfTheTagOnlyWhenItChangedAndNoWriteRuns() {
        XCTAssertEqual(
            ProjectTagPage.renaming("  Customer ", of: client, in: tags, saving: false),
            .edit(.renameChoice(propertyKey: "tags", key: "client", label: "Customer"))
        )
        XCTAssertNil(ProjectTagPage.renaming("Customer", of: client, in: tags, saving: true))
        XCTAssertNil(ProjectTagPage.renaming("   ", of: client, in: tags, saving: false))
        XCTAssertNil(ProjectTagPage.renaming(" Client ", of: client, in: tags, saving: false))
    }

    @MainActor
    func testRecoloringAndDeletingAreForwardedAsChangesOfTheTagsChoices() {
        let model = ScriptedItemScreenModel(state: ItemState(phase: .content))
        let viewModel = ItemViewModel(itemId: "p1", model: model, router: RouterSpy())
        let green = CalendarSwatch(key: "green", hex: "#34C759")
        viewModel.send(ProjectTagPage.recoloring("client", to: green, in: tags))
        viewModel.send(ProjectTagPage.removal(of: "client", in: tags))
        XCTAssertEqual(
            model.actions,
            [
                .edit(.recolorChoice(propertyKey: "tags", key: "client", color: "#34C759")),
                .edit(.removeChoice(propertyKey: "tags", key: "client"))
            ]
        )
    }

    func testTheTagScreenClosesOnlyOnceItsTagWasShownAndIsGone() {
        let home = FieldOption(key: "home", label: "Home", color: nil)
        let cases: [(before: [FieldOption], now: [FieldOption], closes: Bool)] = [
            ([client, home], [home], true),
            ([], [client, home], false),
            ([], [], false),
            ([client], [client.relabelled("Customer")], false),
            ([home], [], false)
        ]
        for (before, now, closes) in cases {
            XCTAssertEqual(
                ProjectTagPage.wasRemoved("client", before: before, now: now),
                closes,
                "\(before.map(\.key)) -> \(now.map(\.key))"
            )
        }
    }

    @MainActor
    func testTheTagListReadsTheTagsAgainOnEveryAppearanceButTheFirst() {
        let model = ScriptedItemScreenModel(state: ItemState(phase: .content))
        let viewModel = ItemViewModel(itemId: "p1", model: model, router: RouterSpy())
        var hasAppeared = false
        ProjectTagsScreen.appeared(&hasAppeared, send: viewModel.send)
        XCTAssertEqual(model.actions, [])
        ProjectTagsScreen.appeared(&hasAppeared, send: viewModel.send)
        XCTAssertEqual(model.actions, [.refresh])
        ProjectTagsScreen.appeared(&hasAppeared, send: viewModel.send)
        XCTAssertEqual(model.actions, [.refresh, .refresh])
    }

    func testEveryColourOfThePaletteHasAName() {
        let keys = ["red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink", "brown", "gray"]
        for key in keys {
            let swatch = CalendarSwatch(key: key, hex: "#000000")
            XCTAssertNotEqual(swatch.tagColorName, swatch.hex, "\(key) has no name")
        }
        XCTAssertEqual(CalendarSwatch(key: "unknown", hex: "#123456").tagColorName, "#123456")
    }

    func testASwatchIsTheTagsColourWhateverItsCase() {
        let green = CalendarSwatch(key: "green", hex: "#34C759")
        XCTAssertTrue(green.isTagColor("#34c759"))
        XCTAssertFalse(green.isTagColor("#FF9500"))
        XCTAssertFalse(green.isTagColor(nil))
    }
}

// MARK: - Helpers
private extension FieldOption {

    func relabelled(_ label: String) -> FieldOption {
        FieldOption(key: key, label: label, color: color)
    }
}
