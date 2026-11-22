import CoreKit
import DesignSystem
import SwiftUI

/// The open threads the signals on screen match, with the button that gives the project to them and what the last
/// assignment did.
struct ProjectMailSignalsPreviewSection: View {

    // MARK: - Dependencies
    let state: ProjectMailSignalsState
    let send: (ProjectMailSignalsAction) -> Void

    // MARK: - Body
    var body: some View {
        Section {
            summary
            ForEach(state.preview.threads) { thread in row(thread) }
            if let assignment = state.assignment { result(assignment) }
            assignButton
        } header: {
            Text("mail.signals.preview", bundle: .module)
        } footer: {
            footer
        }
    }
}

// MARK: - Subviews
private extension ProjectMailSignalsPreviewSection {

    @ViewBuilder var summary: some View {
        switch state.preview.phase {
        case .loading where state.preview.threads.isEmpty:
            HStack(spacing: Theme.Spacing.small) {
                ProgressView()
                Text("mail.signals.preview.loading", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            }
        case .error:
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                Text("mail.signals.preview.failed", bundle: .module)
                Text(FailureKind.message(for: state.preview.failure))
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Button { send(.retryPreview) } label: { Text("mail.signals.preview.retry", bundle: .module) }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier(MailIdentifiers.signalsPreviewRetry)
            }
        case .loading, .ready:
            HStack(spacing: Theme.Spacing.small) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: count)
                    if state.preview.alreadyAssigned > 0 {
                        Text(verbatim: format("mail.signals.preview.alreadyAssigned", state.preview.alreadyAssigned))
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                if state.preview.phase == .loading { ProgressView() }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(MailIdentifiers.signalsPreviewCount)
        }
    }

    var count: String {
        state.preview.total == 0
            ? String(localized: "mail.signals.preview.none", bundle: .module)
            : format("mail.signals.preview.count", state.preview.total)
    }

    func row(_ thread: MailSignalThreadItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: thread.subject.isEmpty ? "\u{2014}" : thread.subject)
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: Theme.Spacing.small)
                Text(verbatim: MailFormatting.listTime(thread.lastMessageAt))
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Text(verbatim: thread.senderName.isEmpty ? thread.senderAddress : thread.senderName)
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(MailIdentifiers.signalsThreadPrefix + thread.threadId)
    }

    func result(_ assignment: MailSignalsAssignment) -> some View {
        HStack {
            Label {
                Text(
                    verbatim: String(
                        format: String(localized: "mail.signals.assigned", bundle: .module),
                        assignment.assigned,
                        assignment.skipped
                    )
                )
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            Spacer(minLength: 0)
            Button { send(.dismissAssignment) } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("mail.signals.assigned.dismiss", bundle: .module))
        }
        .accessibilityIdentifier(MailIdentifiers.signalsAssignment)
    }

    var assignButton: some View {
        Button { send(.assign) } label: {
            HStack(spacing: Theme.Spacing.small) {
                Text(verbatim: format("mail.signals.assign", state.preview.threads.count))
                if state.assigning { ProgressView() }
            }
        }
        .disabled(!state.canAssign)
        .accessibilityIdentifier(MailIdentifiers.signalsAssign)
    }

    @ViewBuilder var footer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            if state.preview.total > state.preview.threads.count {
                Text(
                    verbatim: String(
                        format: String(localized: "mail.signals.preview.newest", bundle: .module),
                        state.preview.threads.count,
                        state.preview.total
                    )
                )
            }
            if state.unsaved {
                Text("mail.signals.assign.unsaved", bundle: .module)
            }
        }
    }

    func format(_ key: String.LocalizationValue, _ count: Int) -> String {
        String(format: String(localized: key, bundle: .module), count)
    }
}
