import CoreKit
import XCTest

@testable import NotesFeature

final class NotesViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedNotesScreenModel(state: NotesState())
        let viewModel = NotesViewModel(itemId: "i1", model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(NotesState(phase: .content, title: "Notes", selecting: true))
        try await eventually { viewModel.state.title == "Notes" }
        XCTAssertTrue(viewModel.state.selecting)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedNotesScreenModel(state: NotesState())
        let viewModel = NotesViewModel(itemId: "i1", model: model, router: RouterSpy())
        let page = NoteBlockItem(id: "b1", type: .page, indent: 0, done: false, text: "Sub", pageId: "p1", marker: nil)
        viewModel.retry()
        viewModel.add(.todo, text: "buy milk")
        viewModel.add(.text, text: "after", after: "b0")
        viewModel.createSubpage(title: "Ideas")
        viewModel.toggleSelecting()
        viewModel.toggle(page)
        viewModel.moveSelectedToSubpages()
        viewModel.open(page)
        viewModel.convert(page, to: .bullet)
        viewModel.rename(page, to: "New")
        viewModel.openAsText()
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [
                .retry, .add(
                    .todo,
                    text: "buy milk",
                    afterBlockId: nil
                ), .add(.text, text: "after", afterBlockId: "b0"),
                .createSubpage(title: "Ideas", afterBlockId: nil), .toggleSelecting, .toggle(blockId: "b1"),
                .moveSelectedToSubpages, .open(blockId: "b1"), .convertToBlock(blockId: "b1", type: .bullet),
                .renameSubpage(blockId: "b1", title: "New"), .openAsText, .dismissFailure
            ]
        )
    }

    @MainActor
    func testEveryEffectTheModelRaisesReachesTheRouterOnceWithTheItemOfThePage() async throws {
        let router = RouterSpy()
        let model = ScriptedNotesScreenModel(state: NotesState())
        let viewModel = NotesViewModel(itemId: "i1", model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.openPage(itemId: "page-1"))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openAsText)
        try await eventually { router.calls.count == 2 }
        XCTAssertEqual(router.calls, ["page:page-1", "text:i1"])
    }

    @MainActor
    func testARefreshReturnsOnceThePageIsNotLoadingAnymore() async throws {
        let model = ScriptedNotesScreenModel(state: NotesState(phase: .loading))
        let viewModel = NotesViewModel(itemId: "i1", model: model, router: RouterSpy())
        let finished = Received<Bool>()
        let refresh = Task { @MainActor in
            await viewModel.refresh()
            finished.values.append(true)
        }
        defer { refresh.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.actions, [.refresh])
        XCTAssertEqual(finished.values, [], "A refresh without a page lasts while the page loads")
        model.publish(NotesState(phase: .content))
        try await eventually { finished.values == [true] }
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedNotesScreenModel?
        var viewModel: NotesViewModel?
        do {
            let model = ScriptedNotesScreenModel(state: NotesState())
            weakModel = model
            viewModel = NotesViewModel(itemId: "i1", model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Inline text
    func testInlineMarkdownIsStyledAndASoftBreakIsALineBreak() {
        let styled = NoteInline.attributed("A **bold** and `code` word<br>next line")
        XCTAssertEqual(String(styled.characters), "A bold and code word\nnext line")
        XCTAssertEqual(NoteInline.plain("[a link](https://example.cz) and *italic*"), "a link and italic")
        XCTAssertEqual(NoteInline.plain(""), "")
    }

    func testTextThatIsNotMarkdownIsShownAsItIs() {
        XCTAssertEqual(NoteInline.plain("plain text 2 * 3 = 6"), "plain text 2 * 3 = 6")
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

// MARK: - Spies
/// Values a test task received on the main actor.
@MainActor
final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}

@MainActor
final class RouterSpy: NotesRouting {

    // MARK: - Properties
    private(set) var calls: [String] = []

    // MARK: - Protocol conformance
    func showPage(itemId: String) {
        calls.append("page:\(itemId)")
    }

    func showAsText(itemId: String) {
        calls.append("text:\(itemId)")
    }
}
