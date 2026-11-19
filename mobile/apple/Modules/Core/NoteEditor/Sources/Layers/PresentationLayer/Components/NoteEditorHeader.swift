import CoreKit
import DesignSystem
import SwiftUI

/// A full page's title, editable when the page allows it, and the meta line under it: when the page was last edited
/// and how many words it has.
struct NoteEditorHeader: View {

    // MARK: - Dependencies
    let state: NoteEditorState
    let onRename: (String) -> Void

    // MARK: - State
    @State private var title = ""

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if state.titleEditable {
                TextField(text: $title, axis: .vertical) { Text("noteEditor.title.placeholder", bundle: .module) }
                    .font(.largeTitle.bold())
                    .onSubmit { onRename(title) }
                    .accessibilityIdentifier(NoteEditorIdentifiers.title)
            } else if !state.title.isEmpty {
                Text(verbatim: state.title)
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
            }
            meta
        }
        .padding(.horizontal, NoteEditorMetrics.editorInset.width)
        .padding(.bottom, Theme.Spacing.small)
        .onAppear { title = state.title }
        .onChange(of: state.title) { _, next in title = next }
    }
}

// MARK: - Subviews
private extension NoteEditorHeader {

    var meta: some View {
        Text(metaLine)
            .font(.footnote)
            .foregroundStyle(Theme.Colors.secondaryText)
    }

    var metaLine: String {
        let words = String(format: String(localized: "noteEditor.meta.words", bundle: .module), state.wordCount)
        guard let edited = state.lastEditedAt.flatMap(Self.date) else { return words }
        let format = String(localized: "noteEditor.meta.edited", bundle: .module)
        return String(format: format, Self.relative(edited), words)
    }

    static func date(_ iso: String) -> Date? {
        (try? Date(iso, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(iso, strategy: .iso8601))
    }

    /// "just now" within a minute, otherwise as the system says how long ago something was.
    static func relative(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 60 { return String(localized: "noteEditor.meta.justNow", bundle: .module) }
        return date.formatted(.relative(presentation: .named))
    }
}

/// A notice above the blocks: the page changed elsewhere and was read again, or a write failed.
struct NoteProblemBanner: View {

    // MARK: - Dependencies
    let problem: NoteEditorProblem
    let onDismiss: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            Image(systemName: icon).foregroundStyle(Theme.Colors.secondaryText)
            Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) { Image(systemName: "xmark").font(.footnote.weight(.semibold)) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("noteEditor.dismiss", bundle: .module))
        }
        .padding(Theme.Spacing.small)
        .background(Theme.Colors.card, in: .rect(cornerRadius: 10))
        .padding(.vertical, 4)
    }
}

// MARK: - Subviews
private extension NoteProblemBanner {

    var icon: String {
        switch problem {
        case .reloaded: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle"
        }
    }

    var message: String {
        switch problem {
        case .reloaded: String(localized: "noteEditor.problem.reloaded", bundle: .module)
        case .failed(let kind): FailureKind.message(for: kind)
        }
    }
}
