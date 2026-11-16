import CoreKit
import DesignSystem
import SwiftUI

/// One task of a list: its checkbox, its title (tap to rename in place), the line under it and, while it is renamed,
/// a button for Podrobnosti.
struct TaskRowView: View {

    // MARK: - Dependencies
    let row: TaskRow
    let meta: String
    let editing: Bool
    @Binding var draft: String
    var focus: FocusState<TasksScreen.Focus?>.Binding
    let toggle: () -> Void
    let beginEdit: () -> Void
    let commit: () -> Void
    let openDetails: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            checkbox
            VStack(alignment: .leading, spacing: 2) {
                title
                if !meta.isEmpty { Text(meta).font(.subheadline).foregroundStyle(metaStyle) }
            }
            Spacer(minLength: 0)
            if row.flagged {
                Image(systemName: "flag.fill").foregroundStyle(.orange).accessibilityLabel(flagLabel)
            }
            if editing { detailsButton }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(TasksIdentifiers.rowPrefix + row.id)
    }
}

// MARK: - Subviews
private extension TaskRowView {

    var checkbox: some View {
        Button(action: toggle) {
            Image(systemName: row.done ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(row.done ? Theme.Colors.accent : Theme.Colors.secondaryText)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(checkLabel)
        .accessibilityIdentifier(TasksIdentifiers.checkPrefix + row.id)
    }

    @ViewBuilder var title: some View {
        if editing {
            TextField(text: $draft) { Text("tasks.row.title", bundle: .module) }
                .focused(focus, equals: .row(row.id))
                .submitLabel(.done)
                .onSubmit(commit)
                .onChange(of: focus.wrappedValue) { _, new in
                    if new != .row(row.id) { commit() }
                }
        } else {
            Text(row.title)
                .strikethrough(row.done)
                .foregroundStyle(row.done ? Theme.Colors.secondaryText : Color.primary)
                .contentShape(Rectangle())
                .onTapGesture(perform: beginEdit)
        }
    }

    var detailsButton: some View {
        Button(action: openDetails) { Image(systemName: "ellipsis.circle") }
            .buttonStyle(.borderless)
            .accessibilityLabel(detailsLabel)
            .accessibilityIdentifier(TasksIdentifiers.detailsPrefix + row.id)
    }

    var metaStyle: Color {
        if row.done { return Theme.Colors.secondaryText }
        if row.overdue { return Theme.Colors.destructive }
        return row.missed ? Color.orange : Theme.Colors.secondaryText
    }

    var checkLabel: String {
        let key: String.LocalizationValue = row.done ? "tasks.row.markOpen" : "tasks.row.markDone"
        return String(format: String(localized: key, bundle: .module), locale: .current, row.title)
    }

    var detailsLabel: String {
        String(format: String(localized: "tasks.row.details", bundle: .module), locale: .current, row.title)
    }

    var flagLabel: String {
        String(localized: "tasks.row.flagged", bundle: .module)
    }
}
