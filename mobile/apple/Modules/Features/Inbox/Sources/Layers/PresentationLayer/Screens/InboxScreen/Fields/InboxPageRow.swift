import CoreKit
import DesignSystem
import NoteEditor
import SwiftUI

extension EnvironmentValues {

    /// Makes the model of the note editor of a card's page content; `nil` where the Inbox is shown without one.
    @Entry var makeInboxNote: (@MainActor @Sendable (NoteEditorSource) -> any NoteEditorScreenModel)?
}

/// The page content a card writes, in the light note editor under its label; each change goes to the card's field
/// as Markdown.
struct InboxPageRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    @Environment(\.makeInboxNote)
    private var makeNote

    /// The key of the field that holds the content a card writes into a page.
    static let key = "markdown"

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(field.title)
                    .font(.footnote)
                    .foregroundStyle(field.missing ? Theme.Colors.destructive : Theme.Colors.secondaryText)
                if field.edited {
                    Circle().fill(Theme.Colors.accent).frame(width: 6, height: 6)
                        .accessibilityLabel(Text("inbox.edited", bundle: .module))
                }
            }
            if let makeNote {
                NoteEditorFactory.editor(
                    variant: .light,
                    makeModel: { makeNote(.text(field.text)) },
                    router: NoSubpagesRouter(),
                    onTextChanged: { send(.setText(cardId: cardId, key: field.key, text: $0)) }
                )
                .id(cardId)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
