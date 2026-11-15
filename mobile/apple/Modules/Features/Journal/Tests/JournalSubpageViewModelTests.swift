import CoreKit
import XCTest

@testable import JournalFeature

final class JournalSubpageViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedJournalSubpageScreenModel(state: JournalSubpageState(phase: .loading))
        let viewModel = JournalSubpageViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        let block = JournalBlock(index: 0, kind: .text, runs: [JournalRun(text: "Hello")])
        model.publish(JournalSubpageState(phase: .content, blocks: [block]))
        try await eventually { viewModel.state.blocks == [block] }
        XCTAssertEqual(viewModel.state.blocks, [block])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedJournalSubpageScreenModel(state: JournalSubpageState(phase: .content))
        let viewModel = JournalSubpageViewModel(model: model, router: RouterSpy())
        viewModel.retry()
        viewModel.setText(index: 1, text: "x")
        viewModel.toggleDone(index: 2)
        viewModel.addBlock(kind: .quote, text: "q")
        viewModel.openPage(pageId: "jv2", title: "Deeper")
        viewModel.dismissProblem()
        XCTAssertEqual(model.actions, [
            .retry,
            .setText(index: 1, text: "x"),
            .toggleDone(index: 2),
            .addBlock(kind: .quote, text: "q"),
            .openPage(pageId: "jv2", title: "Deeper"),
            .dismissProblem
        ])
    }

    @MainActor
    func testTheOpenPageEffectBecomesARouterCall() async throws {
        let model = ScriptedJournalSubpageScreenModel(
            state: JournalSubpageState(phase: .content),
            effects: [.openPage(pageId: "jv2", title: "Deeper")]
        )
        let router = RouterSpy()
        let viewModel = JournalSubpageViewModel(model: model, router: router)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        try await eventually { router.calls.count == 1 }
        XCTAssertEqual(router.calls, ["page jv2 Deeper"])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedJournalSubpageScreenModel?
        var viewModel: JournalSubpageViewModel?
        do {
            let model = ScriptedJournalSubpageScreenModel(state: JournalSubpageState(phase: .loading))
            weakModel = model
            viewModel = JournalSubpageViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(viewModel)
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel, "Releasing the ViewModel must release the model, which closes the shared one")
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}
