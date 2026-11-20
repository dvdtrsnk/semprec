import XCTest

@testable import NotesFeature

final class NotesPageRouterTests: XCTestCase {

    @MainActor
    func testASubpageOpensWithTheTitlesAboveItAndTheFocusOfANewPage() {
        let notes = NotesRoutingSpy()
        let router = NotesPageRouter(router: notes)
        router.showPage(pageId: "p2", title: "Trip", trail: ["Notes", "Plans"], focusTitle: true)
        XCTAssertEqual(notes.shown.map(\.itemId), ["p2"])
        XCTAssertEqual(notes.shown.first?.trail, ["Notes", "Plans"])
        XCTAssertEqual(notes.shown.first?.focusTitle, true)
    }
}

@MainActor
private final class NotesRoutingSpy: NotesRouting {

    private(set) var shown: [(itemId: String, trail: [String], focusTitle: Bool)] = []

    func showPage(itemId: String, trail: [String], focusTitle: Bool) {
        shown.append((itemId, trail, focusTitle))
    }
}
