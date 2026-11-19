import XCTest

@testable import Semprec

/// The Journal router opens Podrobnosti over the Journal stack and pushes subpages and the Inbox onto it.
final class JournalNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testAnEventOpensPodrobnostiAsASheet() {
        let (router, stack) = makeRouter()
        router.showEvent(id: "e1")
        XCTAssertEqual(stack.sheets, [.details(ItemDetailsTarget(kind: .event, id: "e1"))])
        XCTAssertTrue(stack.pushed.isEmpty)
    }

    @MainActor
    func testASubpageOpensInTheNoteEditorUnderTheJournal() {
        let (router, stack) = makeRouter()
        router.showPage(itemId: "p1", title: "Notes")
        XCTAssertEqual(
            stack.pushed,
            [.notes(itemId: "p1", tab: .journal, trail: [String(localized: "tab.journal")], focusTitle: false)]
        )
        XCTAssertTrue(stack.sheets.isEmpty)
    }

    @MainActor
    func testTheInboxIsPushedOntoTheJournalStack() {
        let (router, stack) = makeRouter()
        router.showInbox()
        XCTAssertEqual(stack.pushed, [.inbox(tab: .journal)])
    }

    // MARK: - Helpers
    @MainActor
    private func makeRouter() -> (AppJournalRouter, JournalStackSpy) {
        let context = NavigationContext()
        let stack = JournalStackSpy()
        context.register(stack, for: .journal)
        return (AppJournalRouter(context: context), stack)
    }
}

// MARK: - Spies
@MainActor
private final class JournalStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension JournalStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
