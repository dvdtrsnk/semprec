import CoreKit
import DesignSystem
import SwiftUI

/// The item's own page: its Markdown drawn without syntax, and an editor for it. A page saves against the version it
/// was read at, so a page changed elsewhere meanwhile is refused instead of overwritten.
struct PagePanel: View {

    // MARK: - Dependencies
    let page: PageView
    let placeholder: LocalizedStringKey
    let send: (ItemAction) -> Void

    // MARK: - State
    @State private var isEditing = false
    @State private var draft = ""

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            content
            if page.status == .ready || page.status == .saving {
                Button {
                    draft = page.markdown
                    isEditing = true
                } label: {
                    Label { Text("page.edit", bundle: .module) } icon: { Image(systemName: "square.and.pencil") }
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier(CollectionsIdentifiers.pageEditor)
            }
        }
        .sheet(isPresented: $isEditing) { editor }
    }
}

// MARK: - Subviews
private extension PagePanel {

    @ViewBuilder var content: some View {
        switch page.status {
        case .loading:
            ProgressView()
        case .error, .conflict:
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                Text(FailureKind.message(for: page.failure)).foregroundStyle(Theme.Colors.secondaryText)
                Button { send(.page(.reload)) } label: { Text("page.retry", bundle: .module) }
            }
        case .ready, .saving:
            if page.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(placeholder, bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            } else {
                MarkdownView(markdown: page.markdown)
            }
        }
    }

    var editor: some View {
        NavigationStack {
            TextEditor(text: $draft)
                .padding(Theme.Spacing.small)
                .navigationTitle(Text("page.editor.title", bundle: .module))
                .inlineNavigationTitle()
                .toolbar {
                    PlainToolbarItem(placement: .cancellationAction) {
                        Button { isEditing = false } label: { Text("page.cancel", bundle: .module) }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            send(.page(.save(draft)))
                            isEditing = false
                        } label: { Text("page.save", bundle: .module) }
                    }
                }
        }
        .accessibilityIdentifier(CollectionsIdentifiers.pageEditor + ".sheet")
    }
}
