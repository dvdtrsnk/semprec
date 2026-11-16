import CoreKit
import DesignSystem
import SwiftUI

/// The two buttons under the stack: discard on the left, approve on the right. While a card is dragged to one side,
/// the button of that side grows and the other shrinks, as in the design.
struct InboxDecisionBar: View {

    // MARK: - Dependencies
    let card: InboxCard?
    let busy: Bool
    let dragOffset: CGFloat
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Button {
                send(.reject)
            } label: {
                Label { Text(rejectTitle, bundle: .module) } icon: { Image(systemName: "xmark") }
                    .frame(maxWidth: .infinity, minHeight: Theme.Layout.buttonHeight)
            }
            .buttonStyle(.glass)
            .disabled(card == nil || busy)
            .opacity(1 - leftward)
            .accessibilityIdentifier(InboxIdentifiers.reject)
            Button {
                send(.approve)
            } label: {
                Label { Text(approveTitle, bundle: .module) } icon: { Image(systemName: "checkmark") }
                    .frame(maxWidth: .infinity, minHeight: Theme.Layout.buttonHeight)
            }
            .buttonStyle(.glassProminent)
            .tint(Theme.Colors.brand)
            .disabled(!ready)
            .accessibilityIdentifier(InboxIdentifiers.approve)
        }
        .controlSize(.large)
        .animation(.snappy, value: dragOffset)
    }
}

// MARK: - Private
private extension InboxDecisionBar {

    var ready: Bool { card?.approvable == .ready && !busy }

    /// How far the card is dragged to the left, between 0 and 1.
    var leftward: Double { min(1, max(0, Double(-dragOffset) / 200)) }

    var isApproval: Bool { card?.type == .approval }

    var rejectTitle: LocalizedStringKey { isApproval ? "inbox.deny" : "inbox.discard" }

    var approveTitle: LocalizedStringKey {
        switch card?.type {
        case .approval: "inbox.approve"
        case .clarify: "inbox.prepare"
        default: "inbox.process"
        }
    }
}
