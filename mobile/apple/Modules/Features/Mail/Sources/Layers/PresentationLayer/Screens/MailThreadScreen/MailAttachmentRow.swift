import CoreKit
import DesignSystem
import SwiftUI

/// A file of a message: the type, the name, the size and the project it is stored under, with Save to Files while it
/// has no Files item and Open once it has one. A save in progress shows its progress, a failed one says why and can be
/// asked for again.
struct MailAttachmentRow: View {

    // MARK: - Dependencies
    let file: MailAttachmentItem
    let save: () -> Void
    let open: (String) -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small / 2) {
            HStack(spacing: Theme.Spacing.small + 4) {
                Text(verbatim: MailFormatting.fileExtension(file.filename))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                description
                Spacer(minLength: 0)
                action
            }
            if file.savePhase == .failed {
                Text(verbatim: MailContentUnavailable.message(for: file.saveFailure, unavailable: file.saveUnavailable))
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.destructive)
                    .accessibilityIdentifier(MailIdentifiers.attachmentFailurePrefix + file.attachmentId)
            }
        }
        .padding(Theme.Spacing.small)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Subviews
private extension MailAttachmentRow {

    var description: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: file.filename).font(.subheadline.weight(.medium)).lineLimit(1)
            HStack(spacing: 6) {
                Text(verbatim: MailFormatting.fileSize(file.byteSize)).font(.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                MailLinkChip(text: projectText, link: file.project.link)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder var action: some View {
        if let fileItemId = file.fileItemId {
            VStack(alignment: .trailing, spacing: 2) {
                Button { open(fileItemId) } label: { Text("mail.attachment.open", bundle: .module) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier(MailIdentifiers.attachmentOpenPrefix + file.attachmentId)
                if file.savePhase == .saved {
                    Label { Text("mail.attachment.saved", bundle: .module) } icon: { Image(systemName: "checkmark") }
                        .font(.caption2)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        } else if file.savePhase == .saving {
            HStack(spacing: Theme.Spacing.small / 2) {
                ProgressView().controlSize(.small)
                Text("mail.attachment.saving", bundle: .module).font(.caption)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(MailIdentifiers.attachmentSavingPrefix + file.attachmentId)
        } else {
            Button(action: save) {
                Label { Text("mail.attachment.save", bundle: .module) } icon: {
                    Image(systemName: "square.and.arrow.down")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier(MailIdentifiers.attachmentSavePrefix + file.attachmentId)
        }
    }

    var projectText: String {
        file.project.text ?? String(localized: "mail.thread.noProject", bundle: .module)
    }
}
