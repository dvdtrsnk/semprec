import CoreKit
import XCTest

@testable import NoteEditor

@MainActor
final class NoteEditorViewModelTests: XCTestCase {

    /// A model that, like the shared one, changes its state at once on `send`, while the change reaches observers
    /// later and may be overtaken.
    @MainActor
    private final class LaggingModel: NoteEditorScreenModel {

        private(set) var state: NoteEditorState
        private var continuation: AsyncStream<NoteEditorState>.Continuation?

        init(state: NoteEditorState) {
            self.state = state
        }

        func states() -> AsyncStream<NoteEditorState> {
            let (stream, continuation) = AsyncStream.makeStream(of: NoteEditorState.self)
            continuation.yield(state)
            self.continuation = continuation
            return stream
        }

        func effects() -> AsyncStream<NoteEditorEffect> {
            AsyncStream { _ in }
        }

        func send(_ action: NoteEditorAction) {
            guard case .typing(.setRuns(let blockId, let runs)) = action else { return }
            state.blocks = state.blocks.map { block in
                block.id == blockId ? NoteEditorBlock(id: blockId, type: block.type, runs: runs) : block
            }
        }

        /// Hands observers `snapshot`, a state the model has since left.
        func deliver(_ snapshot: NoteEditorState) {
            continuation?.yield(snapshot)
        }
    }

    func testAChangeThatArrivesLateDoesNotUndoWhatWasTypedSince() async throws {
        let start = NoteEditorState(phase: .content, blocks: [NoteEditorBlock(id: "a", type: .text)])
        let model = LaggingModel(state: start)
        let viewModel = NoteEditorViewModel(
            variant: .full,
            model: model,
            router: NoSubpagesRouter(),
            onTextChanged: { _ in }
        )
        let observing = Task { await viewModel.observe() }
        defer { observing.cancel() }
        try await Task.sleep(for: .milliseconds(50))

        viewModel.typing(.setRuns(blockId: "a", runs: [NoteEditorRun("c")]))
        let typed = model.state
        viewModel.typing(.setRuns(blockId: "a", runs: [NoteEditorRun("ch")]))
        model.deliver(typed)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.state.blocks.first?.runs, [NoteEditorRun("ch")])
    }
}
