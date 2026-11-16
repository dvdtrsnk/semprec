import CoreKit
import DesignSystem
import SwiftUI

/// One invitation: who invites, what, when and where, with the answers while it waits for one, or the answer it got.
/// A notice of a shared calendar is only acknowledged.
struct InvitationRow: View {

    // MARK: - Dependencies
    let item: InvitationItem
    /// The invitation whose answer is being sent; every answer waits for it.
    let answering: String?
    let reply: (InvitationReply) -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack(alignment: .top, spacing: Theme.Spacing.small) {
                Capsule()
                    .fill(tint)
                    .frame(width: Self.barWidth)
                details
                Spacer(minLength: 0)
                if let label = item.statusLabel {
                    statusChip(label)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if item.status == .pending {
                actions
            }
        }
        .padding(.vertical, Self.verticalPadding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarSheetIdentifiers.invitationRow(item.id))
    }
}

// MARK: - Subviews
private extension InvitationRow {

    static let barWidth: CGFloat = 4
    static let verticalPadding: CGFloat = 4

    var tint: Color {
        item.kind == .invite ? Theme.Colors.accent : Color.teal
    }

    var details: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.kicker)
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
            Text(item.title)
                .font(.headline)
            if let when = item.when {
                Text(when)
                    .font(.subheadline)
            }
            if let meta = item.meta {
                Text(meta)
                    .font(.subheadline)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    func statusChip(_ label: String) -> some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(item.statusTint)
            .padding(.horizontal, Theme.Spacing.small)
            .padding(.vertical, 3)
            .background(item.statusTint.opacity(Self.chipOpacity), in: .capsule)
            .accessibilityIdentifier(CalendarSheetIdentifiers.invitationsStatus)
    }

    static let chipOpacity: Double = 0.14

    @ViewBuilder var actions: some View {
        HStack(spacing: 0) {
            if item.kind == .invite {
                answer(.accept, Text("invitations.accept", tableName: "Sheets", bundle: .module), weight: .semibold)
                Divider()
                answer(.tentative, Text("invitations.tentative", tableName: "Sheets", bundle: .module))
                Divider()
                answer(.decline, Text("invitations.decline", tableName: "Sheets", bundle: .module), role: .destructive)
            } else {
                answer(.acknowledge, Text("invitations.acknowledge", tableName: "Sheets", bundle: .module))
            }
        }
        .frame(minHeight: Theme.Layout.rowHeight - Theme.Spacing.medium)
        .disabled(answering != nil)
        .overlay {
            if answering == item.id {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.regularMaterial, in: .rect(cornerRadius: Theme.Spacing.small))
            }
        }
    }

    func answer(
        _ answer: InvitationReply,
        _ title: Text,
        weight: Font.Weight = .regular,
        role: ButtonRole? = nil
    ) -> some View {
        Button(role: role) { reply(answer) } label: {
            title
                .fontWeight(weight)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier(Self.identifier(answer))
    }

    static func identifier(_ answer: InvitationReply) -> String {
        switch answer {
        case .accept: CalendarSheetIdentifiers.invitationsAccept
        case .tentative: CalendarSheetIdentifiers.invitationsTentative
        case .decline: CalendarSheetIdentifiers.invitationsDecline
        case .acknowledge: CalendarSheetIdentifiers.invitationsAcknowledge
        }
    }
}

// MARK: - Preview
#Preview("Rows") {
    List {
        ForEach(InvitationsState.previewPending.items) { InvitationRow(item: $0, answering: nil, reply: { _ in }) }
        ForEach(InvitationsState.previewAnswered.items) { InvitationRow(item: $0, answering: nil, reply: { _ in }) }
    }
}
