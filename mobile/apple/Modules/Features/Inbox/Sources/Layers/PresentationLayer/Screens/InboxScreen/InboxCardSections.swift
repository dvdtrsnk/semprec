import CoreKit
import DesignSystem
import SwiftUI

/// What the card was made from, in a grey box: the captured text with its files, the transcript, or the run that
/// asked. A tap on a file opens it; the one being made ready shows a progress indicator.
struct InboxSourceView: View {

    // MARK: - Dependencies
    let card: InboxCard
    /// The id of the attachment being made ready to preview.
    let openingAttachment: String?
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        if shown {
            VStack(alignment: .leading, spacing: 6) {
                if let origin = card.origin {
                    lines(for: origin)
                }
                ForEach(card.quotes, id: \.self) { quote in
                    Text(quote).font(.body)
                }
                if let meta {
                    Text(meta).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Theme.Colors.groupedBackground, in: .rect(cornerRadius: 16))
        }
    }
}

// MARK: - Private
private extension InboxSourceView {

    var shown: Bool { card.origin != nil || !card.quotes.isEmpty }

    @ViewBuilder
    func lines(for origin: InboxOrigin) -> some View {
        switch origin.kind {
        case .capture:
            if let text = origin.text, !text.isEmpty { Text(text).font(.body) }
            ForEach(origin.attachments) { attachment in
                attachmentButton(attachment)
            }
        case .transcript:
            Label {
                Text(origin.name ?? String(localized: "inbox.transcript", bundle: .module)).font(.subheadline.bold())
            } icon: {
                Image(systemName: "waveform")
            }
        case .run:
            if let title = origin.threadTitle ?? origin.heartbeatName ?? origin.mcpClientName {
                Text(title).font(.subheadline.bold())
            }
        }
    }

    var meta: String? {
        guard let origin = card.origin else { return nil }
        switch origin.kind {
        case .capture:
            let when = InboxFormatting.captured(date: origin.date, time: origin.time)
            let captured = when.map { String(format: String(localized: "inbox.captured", bundle: .module), $0) }
            return [captured, origin.typeLabel].compactMap { $0 }.joined(separator: " · ")
        case .transcript:
            return InboxFormatting.day(origin.date)
        case .run:
            return runSource(origin)
        }
    }

    func attachmentButton(_ attachment: InboxAttachment) -> some View {
        let opening = openingAttachment == attachment.id
        return Button {
            send(.openAttachment(cardId: card.id, attachmentId: attachment.id))
        } label: {
            HStack(spacing: 6) {
                Label(
                    attachment.name ?? String(localized: "inbox.attachment", bundle: .module),
                    systemImage: "paperclip"
                )
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.accent)
                if opening {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityLabel(Text("inbox.attachment.opening", bundle: .module))
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(opening)
        .accessibilityIdentifier(InboxIdentifiers.attachmentPrefix + attachment.id)
    }

    func runSource(_ origin: InboxOrigin) -> String {
        switch origin.sourceKind {
        case "tick": String(localized: "inbox.source.tick", bundle: .module)
        case "mcp": String(localized: "inbox.source.mcp", bundle: .module)
        default: String(localized: "inbox.source.chat", bundle: .module)
        }
    }
}

/// What Semp says about the card that is not a field: it is computing, its computation failed, it cannot be used,
/// or it needs the person to say what it is.
struct InboxNoticeView: View {

    // MARK: - Dependencies
    let card: InboxCard
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            switch card.approvable {
            case .computing:
                HStack(spacing: Theme.Spacing.small) {
                    ProgressView()
                    Text("inbox.computing", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                }
            case .computeFailed:
                failed
            case .unsupported:
                note("inbox.unsupported")
            case .invalid, .ready, .missingFields:
                invalidOrHint
            }
        }
    }
}

// MARK: - Private
private extension InboxNoticeView {

    @ViewBuilder var invalidOrHint: some View {
        if let text = card.invalidText {
            HStack(alignment: .top, spacing: Theme.Spacing.small) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.Colors.destructive)
                Text(text).font(.subheadline).foregroundStyle(Theme.Colors.destructive)
            }
            .padding(Theme.Spacing.small + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.destructive.opacity(0.08), in: .rect(cornerRadius: 16))
            .accessibilityElement(children: .combine)
        } else if card.type == .clarify {
            note("inbox.clarify.hint")
        } else if let reason = card.reason {
            hint(reason)
        }
    }

    var failed: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            note("inbox.computeFailed")
            Button {
                send(.recompute(cardId: card.id))
            } label: {
                Label { Text("inbox.recompute", bundle: .module) } icon: { Image(systemName: "arrow.clockwise") }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier(InboxIdentifiers.recompute)
        }
    }

    func note(_ key: LocalizedStringKey) -> some View {
        Text(key, bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
    }

    func hint(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "sparkles").font(.footnote).foregroundStyle(.tertiary)
            Text(text).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.horizontal, 2)
    }
}

/// What an approval request of Semp asks for: how risky it is, the operation, and why the agent asked.
struct InboxApprovalView: View {

    // MARK: - Dependencies
    let card: InboxCard

    // MARK: - Body
    var body: some View {
        if let approval = card.approval {
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                HStack(spacing: 6) {
                    Text(approval.risk.text)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .foregroundStyle(approval.risk.tint)
                        .background(approval.risk.tint.opacity(0.14), in: .capsule)
                    Text(approval.operation)
                        .font(.caption)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(.quaternary, in: .capsule)
                }
                if let reason = approval.reason {
                    Text(reason).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        } else {
            Text("inbox.approval.unknown", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}
