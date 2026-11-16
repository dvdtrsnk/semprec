import CoreKit
import DesignSystem
import SwiftUI

/// The round avatar of a sender: initials on a color that stays the same for the same address.
struct MailAvatar: View {

    // MARK: - Dependencies
    let name: String
    let address: String
    var size: CGFloat = 38

    // MARK: - Body
    var body: some View {
        Text(verbatim: MailFormatting.initials(name: name, address: address))
            .font(.system(size: size * 0.37, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(MailFormatting.avatarColor(address), in: Circle())
            .accessibilityHidden(true)
    }
}

/// A small label capsule of a row: the account, the sender's relationship and project, or Semp's draft.
struct MailTag: View {

    // MARK: - Dependencies
    let text: Text
    var symbol: String?
    var style: Style = .neutral

    enum Style {

        case neutral
        case person
        case draft
    }

    // MARK: - Body
    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 9, weight: .semibold)) }
            text.font(.caption2.weight(.semibold)).lineLimit(1)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(background, in: Capsule())
    }
}

// MARK: - Private
private extension MailTag {

    var foreground: AnyShapeStyle {
        switch style {
        case .neutral: AnyShapeStyle(Theme.Colors.secondaryText)
        case .person: AnyShapeStyle(Color.teal)
        case .draft: AnyShapeStyle(.background)
        }
    }

    var background: Color {
        switch style {
        case .neutral: Color.secondary.opacity(0.14)
        case .person: Color.teal.opacity(0.14)
        case .draft: Theme.Colors.brand
        }
    }
}

/// One thread of the list: the unread dot, the avatar, the sender, the time, the subject, two lines of the text and
/// the tags that say where it is from and what Semp prepared. The whole row opens the thread.
struct MailThreadRow: View {

    // MARK: - Dependencies
    let thread: MailThreadItem
    let open: () -> Void

    // MARK: - Body
    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: Theme.Spacing.small + 2) {
                Circle()
                    .fill(thread.unread ? Theme.Colors.accent : Color.clear)
                    .frame(width: 10, height: 10)
                    .padding(.top, 14)
                    .accessibilityHidden(true)
                MailAvatar(name: thread.senderName, address: thread.senderAddress)
                VStack(alignment: .leading, spacing: 2) {
                    header
                    subject
                    if let preview = thread.preview, !preview.isEmpty {
                        Text(verbatim: preview)
                            .font(.subheadline)
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .lineLimit(2)
                    }
                    tags
                }
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityLabel(accessibilityLabel)
    }
}

// MARK: - Subviews
private extension MailThreadRow {

    var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: thread.senderName.isEmpty ? thread.senderAddress : thread.senderName)
                .font(.body.weight(thread.unread ? .bold : .medium))
                .lineLimit(1)
            Spacer(minLength: 0)
            if thread.messageCount > 1 {
                Text(verbatim: String(thread.messageCount)).font(.footnote).foregroundStyle(.tertiary)
            }
            Text(verbatim: MailFormatting.listTime(thread.lastMessageAt))
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    var subject: some View {
        HStack(spacing: 6) {
            Text(verbatim: thread.subject)
                .font(.subheadline.weight(thread.unread ? .semibold : .regular))
                .lineLimit(1)
            if thread.hasAttachment {
                Image(systemName: "paperclip").font(.caption).foregroundStyle(.tertiary)
            }
            if thread.flagged {
                Image(systemName: "flag.fill").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    var tags: some View {
        HStack(spacing: 6) {
            ForEach(thread.mailboxNames, id: \.self) { MailTag(text: Text(verbatim: $0)) }
            if let person = personText {
                MailTag(text: Text(verbatim: person), style: .person)
            }
            if thread.hasSempDraft {
                MailTag(text: Text("mail.row.sempDraft", bundle: .module), symbol: "bubble.left", style: .draft)
            }
        }
        .padding(.top, 2)
    }

    /// The sender's relationship and the project (or the company) of the thread, as one tag.
    var personText: String? {
        let parts = [thread.senderRelationship, thread.projectName ?? thread.companyName].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    var accessibilityLabel: Text {
        let sender = thread.senderName.isEmpty ? thread.senderAddress : thread.senderName
        let state = thread.unread ? String(localized: "mail.row.unread", bundle: .module) : ""
        return Text(verbatim: [state, sender, thread.subject].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

// MARK: - Preview
#Preview {
    List {
        MailThreadRow(
            thread: MailThreadItem(
                threadId: "t1",
                subject: "Re: Nabídka na web",
                lastMessageAt: "2026-10-20T12:41:00.000000Z",
                senderName: "Petr Novák",
                senderAddress: "petr@novak.cz",
                senderRelationship: "Klient",
                messageCount: 4,
                preview: "Díky, rozpočet nám sedí. Můžeme začít v listopadu?",
                hasAttachment: true,
                unread: true,
                flagged: true,
                mailboxNames: ["Gmail"],
                projectName: "Web pro klienta",
                hasSempDraft: true
            ),
            open: {}
        )
    }
}
