import CoreKit
import DesignSystem
import SwiftUI

/// One approval request: what Semp wants to do, how risky it is, and the two answers; once decided, how it came out.
struct SempApprovalCard: View {

    // MARK: - Dependencies
    let item: SempApprovalItem
    /// Called with `true` to approve, `false` to reject.
    let decide: (Bool) -> Void
    /// Extra content under the target, such as the parameters of the request.
    var details: AnyView?

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Text(item.title).font(.headline)
            if let target = item.target {
                Text(target).font(.subheadline).foregroundStyle(.secondary)
            }
            Text(item.sourceLabel).font(.caption).foregroundStyle(.secondary)
            if let details { details }
            footer
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SempIdentifiers.approvalPrefix + item.id)
    }
}

// MARK: - Subviews
private extension SempApprovalCard {

    var header: some View {
        HStack {
            Text("semp.approval.wants", bundle: .module)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            Spacer()
            Text(item.riskLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(riskColor)
                .background(riskColor.opacity(0.14), in: Capsule())
        }
    }

    @ViewBuilder var footer: some View {
        if item.decision == .pending {
            VStack(alignment: .leading, spacing: 6) {
                if item.decisionFailed {
                    Text(FailureKind.sempMessage(for: item.decisionFailure))
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.destructive)
                }
                HStack(spacing: 10) {
                    Button { decide(false) } label: {
                        Text("semp.approval.reject", bundle: .module).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(SempIdentifiers.reject)
                    Button { decide(true) } label: {
                        Text("semp.approval.approve", bundle: .module).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier(SempIdentifiers.approve)
                }
                .controlSize(.large)
            }
        } else if let outcome = item.outcomeLabel {
            HStack(spacing: 8) {
                if item.decision == .approving || item.decision == .rejecting || item.decision == .queued {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: outcomeSymbol).foregroundStyle(outcomeColor)
                }
                Text(outcome).font(.subheadline).foregroundStyle(outcomeColor)
            }
            .accessibilityElement(children: .combine)
        }
    }

    var riskColor: Color {
        switch item.risk {
        case .irreversible: Theme.Colors.destructive
        case .outbound: Theme.Colors.sempWaiting
        case .breaksLink: Theme.Colors.accent
        case .write: Theme.Colors.secondaryText
        }
    }

    var outcomeColor: Color {
        switch item.decision {
        case .executed: Theme.Colors.sempSuccess
        case .conflict: Theme.Colors.sempWaiting
        case .approving, .rejecting, .queued: Theme.Colors.accent
        case .rejected, .pending: Theme.Colors.secondaryText
        }
    }

    var outcomeSymbol: String {
        switch item.decision {
        case .executed: "checkmark.circle.fill"
        case .conflict: "exclamationmark.triangle.fill"
        case .rejected: "xmark.circle.fill"
        case .approving, .rejecting, .queued, .pending: "circle"
        }
    }
}

#Preview {
    SempApprovalCard(
        item: SempApprovalItem(
            id: "a1",
            descriptionKey: "approval.itemDelete",
            descriptionParams: ["itemName": "Daňové přiznání – podklady", "databaseName": "Úkoly"],
            risk: .irreversible,
            threadTitle: "Plán na dnešek"
        ),
        decide: { _ in }
    )
    .padding()
}
