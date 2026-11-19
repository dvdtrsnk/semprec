import CoreKit
import DesignSystem
import NoteEditor
import SwiftUI

/// The Inbox: the cards Semp and the captures wait on, one on top of the other. The person approves a card, edits it
/// by hand first, or discards it; a swipe to the right approves, a swipe to the left discards.
struct InboxScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: InboxViewModel
    /// Set while a card's page content is edited or its blocks are selected; the check then ends that.
    @StateObject private var noteFocus = NoteEditorFocus()

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> InboxViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text("inbox.title", bundle: .module))
            .navigationSubtitle(subtitle)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if noteFocus.isActive { NoteFocusDoneButton(focus: noteFocus) } else { undoButton }
                }
            }
            .environment(\.inboxNoteFocus, noteFocus)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(InboxIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension InboxScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure))) { viewModel.send(.retry) })
        case .content(let content):
            if content.cards.isEmpty {
                InboxEmptyView(handled: content.handled, dropped: content.dropped)
            } else {
                InboxDeckView(content: content, send: viewModel.send)
            }
        }
    }

    var subtitle: Text {
        guard case .content(let content) = viewModel.state else { return Text(verbatim: "") }
        guard !content.cards.isEmpty else { return Text("inbox.counter.done", bundle: .module) }
        return Text(
            String(format: String(localized: "inbox.counter", bundle: .module), locale: .current, content.cards.count)
        )
    }

    var canUndo: Bool {
        guard case .content(let content) = viewModel.state else { return false }
        return content.canUndo && !content.busy
    }

    var undoButton: some View {
        Button {
            viewModel.send(.undo)
        } label: {
            Label { Text("inbox.undo", bundle: .module) } icon: { Image(systemName: "arrow.uturn.backward") }
        }
        .disabled(!canUndo)
        .accessibilityIdentifier(InboxIdentifiers.undo)
    }
}

// MARK: - Preview
#Preview("Inbox") {
    NavigationStack {
        InboxScreen(
            viewModel: InboxViewModel(
                model: ScriptedInboxScreenModel(state: .content(InboxPreviewData.content)),
                router: PreviewInboxRouter()
            )
        )
    }
}
