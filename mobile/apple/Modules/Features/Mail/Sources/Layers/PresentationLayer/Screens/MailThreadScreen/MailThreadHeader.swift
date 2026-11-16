import CoreKit
import DesignSystem
import SwiftUI

/// The top of a thread: the subject, the sender, the company and the project of the thread with the chains that say
/// where each comes from, and the account with the number of messages.
struct MailThreadHeader: View {

    // MARK: - Dependencies
    let state: MailThreadState

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text(verbatim: state.subject)
                .font(.title2.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.small) {
                    sender
                    MailLinkChip(text: companyText, link: state.company.link)
                    MailLinkChip(text: projectText, link: state.project.link)
                }
            }
            Text(verbatim: summary)
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.top, Theme.Spacing.small)
    }
}

// MARK: - Subviews
private extension MailThreadHeader {

    var sender: some View {
        HStack(spacing: 6) {
            MailAvatar(name: state.senderName, address: state.senderAddress, size: 22)
            Text(verbatim: senderText).font(.caption.weight(.medium)).lineLimit(1)
        }
        .padding(.leading, 3)
        .padding(.trailing, Theme.Spacing.small)
        .padding(.vertical, 3)
        .background(Color.secondary.opacity(0.12), in: Capsule())
    }

    var senderText: String {
        let parts = [state.senderName, state.senderRelationship].compactMap(\.self)
        return parts.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    var companyText: String {
        state.company.text ?? String(localized: "mail.thread.noCompany", bundle: .module)
    }

    var projectText: String {
        state.project.text ?? String(localized: "mail.thread.noProject", bundle: .module)
    }

    var summary: String {
        let format = String(localized: "mail.thread.summary", bundle: .module)
        let accounts = state.mailboxNames.joined(separator: ", ")
        return String(format: format, locale: .current, accounts, state.messageCount)
    }
}
