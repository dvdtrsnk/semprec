import CoreGraphics
import CoreKit
import XCTest

@testable import CollectionsFeature

/// The writes of the tags sheet of the project settings, the row that leads to it, the rows its chips wrap into and
/// the names of the colours a tag can take.
final class ProjectTagsSheetTests: XCTestCase {

    // MARK: - Properties
    private let client = FieldOption(key: "client", label: "Client", color: "#FF9500")
    private let home = FieldOption(key: "home", label: "Home", color: nil)
    private let work = FieldOption(key: "work", label: "Work", color: "#34C759")

    // MARK: - Tests
    func testTheCheckmarkSetsTheChosenTagsInTheirOrderAndNothingWhenTheProjectHoldsThemAlready() {
        let tags = tags(held: [client])
        XCTAssertEqual(
            ProjectTagsSheet.choosing(["work", "client"], in: tags),
            .edit(.setChoices(propertyKey: "tags", keys: ["client", "work"]))
        )
        XCTAssertEqual(ProjectTagsSheet.choosing([], in: tags), .edit(.setChoices(propertyKey: "tags", keys: [])))
        XCTAssertNil(ProjectTagsSheet.choosing(["client"], in: tags))
        XCTAssertNil(ProjectTagsSheet.choosing(["client", "deleted"], in: tags), "a deleted tag is left out")
    }

    func testTheHeldKeysAreTheProjectsTagsInItsOrder() {
        XCTAssertEqual(ProjectTagsSheet.heldKeys(of: tags(held: [work, client])), ["work", "client"])
        XCTAssertEqual(ProjectTagsSheet.heldKeys(of: tags(held: [])), [])
    }

    func testATypedNameThatIsAlreadyATagMeansThatTagWhateverItsCase() {
        let tags = tags(held: [])
        XCTAssertEqual(ProjectTagsSheet.existingTag(named: "  client ", in: tags), client)
        XCTAssertNil(ProjectTagsSheet.existingTag(named: "Clients", in: tags))
    }

    func testANewTagIsCreatedWithItsTrimmedNameOnlyWhenNotBlankAndNoWriteRuns() {
        let tags = tags(held: [])
        XCTAssertEqual(
            ProjectTagsSheet.creating("  Garden ", in: tags, saving: false),
            .edit(.addChoice(propertyKey: "tags", label: "Garden"))
        )
        XCTAssertNil(ProjectTagsSheet.creating("Garden", in: tags, saving: true))
        XCTAssertNil(ProjectTagsSheet.creating("   ", in: tags, saving: false))
    }

    func testOnlyTheTagsThatAppearedSinceTheNameWasSentAreTheCreatedOnes() {
        XCTAssertEqual(ProjectTagsSheet.added(since: ["client"], now: [client, home]), ["home"])
        XCTAssertEqual(ProjectTagsSheet.added(since: ["client", "home"], now: [client, home]), [])
        XCTAssertEqual(ProjectTagsSheet.added(since: nil, now: [client, home]), [], "no name was sent")
    }

    func testRenamingSendsTheTrimmedNameOnlyWhenItChangedAndNoWriteRuns() {
        let tags = tags(held: [client])
        XCTAssertEqual(
            ProjectTagsSheet.renaming("  Customer ", of: client, in: tags, saving: false),
            .edit(.renameChoice(propertyKey: "tags", key: "client", label: "Customer"))
        )
        XCTAssertNil(ProjectTagsSheet.renaming("Customer", of: client, in: tags, saving: true))
        XCTAssertNil(ProjectTagsSheet.renaming("   ", of: client, in: tags, saving: false))
        XCTAssertNil(ProjectTagsSheet.renaming(" Client ", of: client, in: tags, saving: false))
    }

    @MainActor
    func testRecoloringAndDeletingAreForwardedAsChangesOfTheTagsChoices() {
        let tags = tags(held: [client])
        let model = ScriptedItemScreenModel(state: ItemState(phase: .content))
        let viewModel = ItemViewModel(itemId: "p1", model: model, router: RouterSpy())
        let green = CalendarSwatch(key: "green", hex: "#34C759")
        viewModel.send(ProjectTagsSheet.recoloring("client", to: green, in: tags))
        viewModel.send(ProjectTagsSheet.removal(of: "client", in: tags))
        XCTAssertEqual(
            model.actions,
            [
                .edit(.recolorChoice(propertyKey: "tags", key: "client", color: "#34C759")),
                .edit(.removeChoice(propertyKey: "tags", key: "client"))
            ]
        )
    }

    func testTheSettingsRowSummarizesTheProjectsTags() {
        XCTAssertEqual(ProjectSettingsSheet.summary(of: tags(held: [client, work])), "#Client #Work")
        XCTAssertEqual(ProjectSettingsSheet.summary(of: tags(held: [])), "")
    }

    func testTheSettingsRowShowsARefusedWriteOfTheTagsWhetherASetOrAChoiceChangeFailed() {
        let refused = ItemWriteFailure(propertyKey: "tags", kind: .rejected)
        let other = ItemWriteFailure(propertyKey: "status", kind: .rejected)
        let cases: [(state: ItemState, shown: ItemWriteFailure?)] = [
            (ItemState(phase: .content, writeFailure: refused), refused),
            (ItemState(phase: .content, choiceFailure: refused), refused),
            (ItemState(phase: .content, writeFailure: other, choiceFailure: refused), refused),
            (ItemState(phase: .content, writeFailure: other), nil),
            (ItemState(phase: .content), nil)
        ]
        for (state, shown) in cases {
            XCTAssertEqual(ProjectSettingsSheet.tagsFailure(in: state, propertyKey: "tags"), shown)
        }
    }

    func testChipsWrapOntoANewRowWhereTheNextNoLongerFits() {
        let chip = CGSize(width: 40, height: 20)
        let rows = TagFlowLayout.rows(of: [chip, chip, chip, CGSize(width: 120, height: 30)], width: 100, spacing: 8)
        XCTAssertEqual(rows.map(\.indices), [[0, 1], [2], [3]])
        XCTAssertEqual(rows.map(\.width), [88, 40, 120])
        XCTAssertEqual(rows.map(\.height), [20, 20, 30])
        XCTAssertEqual(TagFlowLayout.rows(of: [chip, chip], width: nil, spacing: 8).map(\.indices), [[0, 1]])
        XCTAssertEqual(TagFlowLayout.rows(of: [], width: 100, spacing: 8), [])
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
private extension ProjectTagsSheetTests {

    func tags(held: [FieldOption]) -> FieldView {
        FieldView(
            propertyKey: "tags",
            name: "Tags",
            kind: .multiSelect,
            content: .choices(held),
            options: [client, home, work],
            editable: true,
            origin: nil
        )
    }
}
