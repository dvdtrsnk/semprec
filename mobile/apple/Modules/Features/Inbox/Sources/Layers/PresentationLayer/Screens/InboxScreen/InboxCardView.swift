import CoreKit
import DesignSystem
import SwiftUI

/// One card: what it is, what it was made from, why Semp proposed it and the fields of the proposal, every one of
/// which the person can change by hand.
struct InboxCardView: View {

    // MARK: - Dependencies
    let card: InboxCard
    let focus: FocusState<String?>.Binding
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.small + 4) {
                InboxCardHeader(card: card)
                InboxSourceView(card: card)
                InboxNoticeView(card: card, send: send)
                if card.type == .approval {
                    InboxApprovalView(card: card)
                } else {
                    sectionHeader
                    InboxFieldsView(card: card, focus: focus, send: send)
                    footer
                }
            }
            .padding(Theme.Spacing.medium + 2)
        }
        .scrollIndicators(.hidden)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .fill(Theme.Colors.card)
                .shadow(color: .black.opacity(0.14), radius: 20, y: 8)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(InboxIdentifiers.card)
    }
}

// MARK: - Subviews
private extension InboxCardView {

    var sectionKey: LocalizedStringKey {
        switch card.type {
        case .clarify: "inbox.section.clarify"
        case .transcriptEvent: "inbox.section.event"
        case .speaker: "inbox.section.speaker"
        default: "inbox.section.proposal"
        }
    }

    var sectionHeader: some View {
        HStack {
            Text(sectionKey, bundle: .module)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.Colors.secondaryText)
            Spacer()
            if card.edited {
                Button {
                    send(.reset(cardId: card.id))
                } label: {
                    Text("inbox.reset", bundle: .module).font(.footnote)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.Colors.accent)
                .accessibilityIdentifier(InboxIdentifiers.reset)
            }
        }
        .padding(.horizontal, 2)
    }

    @ViewBuilder var footer: some View {
        if card.type != .clarify, card.type != .speaker, card.type != .transcriptEvent, !card.groups.isEmpty {
            Text(card.edited ? "inbox.footer.edited" : "inbox.footer", bundle: .module)
                .font(.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.horizontal, 2)
        }
    }
}

/// The chip with the kind of the card and the databases it writes to.
struct InboxCardHeader: View {

    // MARK: - Dependencies
    let card: InboxCard

    // MARK: - Private
    private var targetText: String {
        String(format: String(localized: "inbox.target", bundle: .module), card.targets.joined(separator: ", "))
    }

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Label {
                Text(card.type.chipText)
            } icon: {
                Image(systemName: card.type.symbol)
            }
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(card.type.tint)
            .background(card.type.tint.opacity(0.14), in: .capsule)
            Spacer(minLength: 0)
            if !card.targets.isEmpty {
                Text(targetText)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
        }
    }
}
