import CoreKit
import DesignSystem
import SwiftUI

/// One message of a thread. Closed it shows the sender, the time and the first line; open it shows the recipients, the
/// whole text and the files that came with it. A message whose body is only at the mail provider shows its preview
/// while the body is fetched, and why it could not be fetched with a way to try again.
struct MailMessageCard: View {

    // MARK: - Dependencies
    let message: MailMessageItem
    let send: (MailThreadAction) -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Button { send(.toggleMessage(emailId: message.emailId)) } label: { header }
                .buttonStyle(.plain)
                .accessibilityAddTraits(message.expanded ? .isSelected : [])
            if message.expanded {
                content.padding(.leading, 50)
                ForEach(message.attachments) { file in
                    MailAttachmentRow(
                        file: file,
                        save: { send(.saveAttachment(emailId: message.emailId, attachmentId: file.attachmentId)) },
                        open: { send(.open(.file(fileItemId: $0))) }
                    )
                    .padding(.leading, 50)
                }
            }
        }
        .padding(Theme.Spacing.medium)
    }
}

// MARK: - Subviews
private extension MailMessageCard {

    var header: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small + 4) {
            MailAvatar(name: message.fromName, address: message.fromAddress, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: message.fromName).font(.body.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(verbatim: MailFormatting.messageTime(message.date))
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                if message.expanded {
                    Text(verbatim: recipients).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                } else {
                    Text(verbatim: firstLine)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder var content: some View {
        switch message.bodyPhase {
        case .ready:
            Text(verbatim: message.bodyText)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .remote, .loading:
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                preview
                HStack(spacing: Theme.Spacing.small) {
                    ProgressView().controlSize(.small)
                    Text("mail.message.loading", bundle: .module)
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(MailIdentifiers.messageLoadingPrefix + message.emailId)
            }
        case .failed:
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                preview
                Label {
                    Text(verbatim: MailContentUnavailable.message(
                        for: message.bodyFailure,
                        unavailable: message.bodyUnavailable
                    ))
                } icon: {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                .font(.footnote)
                Button { send(.loadBody(emailId: message.emailId)) } label: {
                    Text("mail.message.retry", bundle: .module)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier(MailIdentifiers.messageRetryPrefix + message.emailId)
            }
        }
    }

    @ViewBuilder var preview: some View {
        if let preview = message.preview, !preview.isEmpty {
            Text(verbatim: preview)
                .font(.body)
                .foregroundStyle(Theme.Colors.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var recipients: String {
        let format = String(localized: "mail.message.to", bundle: .module)
        return String(format: format, locale: .current, message.toNames.joined(separator: ", "))
    }

    /// The first line of the body once it is shown, else the preview the server keeps.
    var firstLine: String {
        guard message.bodyPhase == .ready else { return message.preview ?? "" }
        return message.bodyText.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    }
}
