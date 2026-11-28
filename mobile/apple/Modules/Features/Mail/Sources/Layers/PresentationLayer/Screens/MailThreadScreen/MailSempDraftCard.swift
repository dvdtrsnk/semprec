import CoreKit
import DesignSystem
import SwiftUI

/// The reply Semp prepared: its text, which the person may change, and the buttons to open it in the editor or send it.
/// After the send the card says from which account the message went. The text typed here stays in this view and goes to
/// the shared ViewModel when it is sent.
struct MailSempDraftCard: View {

    // MARK: - Dependencies
    let state: MailThreadState
    let send: (MailThreadAction) -> Void

    // MARK: - State
    @State private var text = ""
    @State private var seededFor: String?

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small + 4) {
            HStack(spacing: Theme.Spacing.small) {
                Image(systemName: "bubble.left").font(.footnote.weight(.semibold))
                Text("mail.draft.title", bundle: .module).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                Text("mail.draft.badge", bundle: .module)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.2), in: Capsule())
            }
            if let draft = state.draft {
                editor(draft)
            } else if let sentFrom = state.sentFrom {
                sent(sentFrom)
            }
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
        .onChange(of: state.draft, initial: true) { _, draft in
            guard let draft, seededFor != draft.id else { return }
            text = draft.body
            seededFor = draft.id
        }
    }
}

// MARK: - Subviews
private extension MailSempDraftCard {

    func editor(_ draft: MailSempDraft) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            if !draft.recipients.isEmpty {
                Text(verbatim: draft.recipients.joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            TextEditor(text: $text)
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.small)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityLabel(Text("mail.draft.text", bundle: .module))
                .accessibilityIdentifier(MailIdentifiers.draftEditor)
            if state.sendPhase == .failed {
                Text(FailureKind.sendMessage(for: state.sendFailure, refusal: state.sendRefusal))
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.destructive)
            }
            HStack {
                Button { send(.open(.draft)) } label: { Text("mail.draft.edit", bundle: .module) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(MailIdentifiers.draftEdit)
                Spacer(minLength: 0)
                Button { send(.sendDraft(body: text)) } label: {
                    Label {
                        Text(state.sendPhase == .sending ? "mail.draft.sending" : "mail.draft.send", bundle: .module)
                    } icon: {
                        Image(systemName: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(state.sendPhase == .sending || text.isEmpty)
                .accessibilityIdentifier(MailIdentifiers.draftSend)
            }
        }
    }

    func sentText(_ account: String) -> String {
        String(format: String(localized: "mail.draft.sentFrom", bundle: .module), locale: .current, account)
    }

    func sent(_ account: String) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text(verbatim: sentText(account))
        }
        .font(.subheadline)
    }
}
