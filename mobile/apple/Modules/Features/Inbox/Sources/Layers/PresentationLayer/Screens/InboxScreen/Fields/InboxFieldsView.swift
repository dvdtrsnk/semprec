import CoreKit
import DesignSystem
import SwiftUI

/// The fields of a card, in the groups the server declares them in. Each control is the one the field's type asks
/// for; what it holds and what it allows come from the shared ViewModel.
struct InboxFieldsView: View {

    // MARK: - Dependencies
    let card: InboxCard
    let focus: FocusState<String?>.Binding
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        ForEach(card.groups) { group in
            VStack(spacing: 0) {
                ForEach(Array(group.fields.enumerated()), id: \.element.id) { index, field in
                    if index > 0 { Divider().padding(.leading, Theme.Spacing.medium) }
                    row(for: field)
                        .accessibilityIdentifier(field.identifier)
                }
            }
            .background(Theme.Colors.groupedBackground.opacity(0.6), in: .rect(cornerRadius: 16))
            .clipShape(.rect(cornerRadius: 16))
        }
    }
}

// MARK: - Subviews
private extension InboxFieldsView {

    @ViewBuilder
    func row(for field: InboxField) -> some View {
        switch field.type {
        case .text:
            InboxTextRow(cardId: card.id, field: field, focus: focus, send: send)
        case .area where field.key == InboxPageRow.key:
            InboxPageRow(cardId: card.id, field: field, send: send)
        case .area:
            InboxAreaRow(cardId: card.id, field: field, focus: focus, send: send)
        case .secret:
            InboxSecretRow(cardId: card.id, field: field, focus: focus, send: send)
        case .date, .datetime:
            InboxWhenRow(cardId: card.id, field: field, send: send)
        case .select:
            InboxSelectRow(cardId: card.id, field: field, send: send)
        case .multi:
            InboxMultiRow(cardId: card.id, field: field, send: send)
        case .toggle:
            InboxToggleRow(cardId: card.id, field: field, send: send)
        case .seg:
            InboxSegRow(cardId: card.id, field: field, send: send)
        case .color:
            InboxColorRow(cardId: card.id, field: field, send: send)
        case .info:
            InboxInfoRow(field: field)
        case .choice:
            InboxChoiceList(cardId: card.id, field: field, send: send)
        case .tile:
            InboxTileRow(cardId: card.id, field: field, send: send)
        }
    }
}

/// The label of a field with the dot that says it was edited by hand, and the control at its trailing edge. A required
/// field that still has no value shows its label in red.
struct InboxRowFrame<Control: View>: View {

    // MARK: - Dependencies
    let field: InboxField
    @ViewBuilder let control: () -> Control

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            HStack(spacing: 6) {
                Text(field.title)
                    .foregroundStyle(field.missing ? Theme.Colors.destructive : Theme.Colors.secondaryText)
                if field.edited {
                    Circle().fill(Theme.Colors.accent).frame(width: 6, height: 6)
                        .accessibilityLabel(Text("inbox.edited", bundle: .module))
                }
            }
            .frame(minWidth: Self.labelWidth, alignment: .leading)
            Spacer(minLength: 0)
            control()
        }
        .padding(.horizontal, 14)
        .frame(minHeight: Theme.Layout.rowHeight)
    }

    // MARK: - Constants
    private static var labelWidth: CGFloat { 88 }
}
