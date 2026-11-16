import CoreKit
import DesignSystem
import SwiftUI

/// The message about a change to a page that did not go through: the page changed meanwhile (reload shows what is
/// there now) or the write failed.
struct JournalProblemBanner: View {

    // MARK: - Dependencies
    let problem: JournalEditProblem
    let onReload: () -> Void
    let onDismiss: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                switch problem {
                case .stale:
                    Text("journal.problem.stale", bundle: .module)
                    Button(action: onReload) { Text("journal.problem.reload", bundle: .module) }
                        .accessibilityIdentifier(JournalIdentifiers.problemReload)
                case .failed(let failure):
                    Text("journal.problem.failed", bundle: .module)
                    Text(FailureKind.message(for: failure)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("journal.problem.dismiss", bundle: .module))
                .accessibilityIdentifier(JournalIdentifiers.problemDismiss)
        }
        .font(.subheadline)
        .padding(Theme.Spacing.medium)
        .background(.regularMaterial, in: .rect(cornerRadius: 16))
        .padding(.horizontal, Theme.Spacing.medium)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(JournalIdentifiers.problem)
    }
}

// MARK: - Preview
#Preview("Stale") {
    JournalProblemBanner(problem: .stale, onReload: {}, onDismiss: {})
}

#Preview("Failed") {
    JournalProblemBanner(problem: .failed(.unavailable), onReload: {}, onDismiss: {})
}
