import CoreKit
import DesignSystem
import SwiftUI

/// One message of a thread. Closed it shows the sender, the time and the first line; open it shows the recipients, the
/// whole text and the files that came with it.
struct MailMessageCard: View {

    // MARK: - Dependencies
    let message: MailMessageItem
    let toggle: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Button(action: toggle) { header }
                .buttonStyle(.plain)
                .accessibilityAddTraits(message.expanded ? .isSelected : [])
            if message.expanded {
                Text(verbatim: message.bodyText)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 50)
                ForEach(message.attachments) { file in
                    MailAttachmentRow(file: file).padding(.leading, 50)
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

    var recipients: String {
        let format = String(localized: "mail.message.to", bundle: .module)
        return String(format: format, locale: .current, message.toNames.joined(separator: ", "))
    }

    var firstLine: String {
        message.bodyText.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    }
}

/// A file of a message: the type, the name, the size and the project it is stored under.
struct MailAttachmentRow: View {

    // MARK: - Dependencies
    let file: MailAttachmentItem

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small + 4) {
            Text(verbatim: MailFormatting.fileExtension(file.filename))
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: file.filename).font(.subheadline.weight(.medium)).lineLimit(1)
                HStack(spacing: 6) {
                    Text(verbatim: MailFormatting.fileSize(file.byteSize)).font(.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    MailLinkChip(text: projectText, link: file.project.link)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.small)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }

    private var projectText: String {
        file.project.text ?? String(localized: "mail.thread.noProject", bundle: .module)
    }
}
