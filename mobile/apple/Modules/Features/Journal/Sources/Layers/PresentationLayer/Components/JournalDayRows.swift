import CoreKit
import DesignSystem
import SwiftUI

/// An event of the selected day: a dot in its project's color, its title, its place and its start time.
struct JournalEventRow: View {

    // MARK: - Dependencies
    let event: JournalEvent
    let onOpen: () -> Void

    // MARK: - Body
    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 14) {
                Circle().fill(color).frame(width: 12, height: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                    Text(meta).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer(minLength: Theme.Spacing.small)
                Text(time).font(.body).monospacedDigit().foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.vertical, 2)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(JournalIdentifiers.eventPrefix + event.id)
    }

    private var color: Color {
        event.projectColor.flatMap(Color.init(hex:)) ?? Theme.Colors.accent
    }

    /// The place, or what the row is when it has none, then whether the transcript is ready.
    private var meta: String {
        let first = event.place ?? String(localized: "journal.event.default", bundle: .module)
        guard event.hasTranscript else { return first }
        return "\(first) · \(String(localized: "journal.event.transcriptReady", bundle: .module))"
    }

    private var time: String {
        guard !event.allDay, let start = event.startMinutes else {
            return String(localized: "journal.event.allDay", bundle: .module)
        }
        return JournalDates.clock(minutes: start)
    }
}

/// A person's birthday on the selected day.
struct JournalBirthdayRow: View {

    // MARK: - Dependencies
    let birthday: JournalBirthday

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "gift.fill").foregroundStyle(.green).frame(width: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(birthday.personName)
                Text("journal.birthday", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
        }
    }
}

/// An Inbox item captured on the selected day: when, its type, its text, its first attachment and where it stands.
struct JournalInboxRow: View {

    // MARK: - Dependencies
    let item: JournalInboxItem

    // MARK: - Body
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.small) {
            Text(item.time ?? "").font(.footnote).monospacedDigit().foregroundStyle(Theme.Colors.secondaryText)
                .frame(minWidth: 40, alignment: .leading)
            Text(item.emoji ?? "+")
            VStack(alignment: .leading, spacing: 4) {
                if let text = item.text { Text(text) }
                if let attachment { Label(attachment, systemImage: "paperclip").font(.footnote) }
                if let status = item.status.message {
                    Text(status).font(.footnote).foregroundStyle(item.status.color)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var attachment: String? {
        guard item.attachmentCount > 0 else { return nil }
        return item.attachmentName ?? String(localized: "journal.inbox.attachment", bundle: .module)
    }
}

// MARK: - Status
private extension JournalInboxStatus {

    var message: String? {
        switch self {
        case .none: nil
        case .pending: String(localized: "journal.inbox.status.pending", bundle: .module)
        case .failed: String(localized: "journal.inbox.status.failed", bundle: .module)
        case .needsClarification: String(localized: "journal.inbox.status.needsClarification", bundle: .module)
        case .proposed: String(localized: "journal.inbox.status.proposed", bundle: .module)
        case .confirmed: String(localized: "journal.inbox.status.confirmed", bundle: .module)
        case .rejected: String(localized: "journal.inbox.status.rejected", bundle: .module)
        case .invalid: String(localized: "journal.inbox.status.invalid", bundle: .module)
        }
    }

    var color: Color {
        switch self {
        case .failed, .invalid, .rejected: Theme.Colors.destructive
        case .proposed, .needsClarification: Theme.Colors.accent
        case .none, .pending, .confirmed: Theme.Colors.secondaryText
        }
    }
}

// MARK: - Preview
#Preview("Rows") {
    VStack(alignment: .leading, spacing: 12) {
        JournalEventRow(
            event: JournalEvent(
                id: "e1", title: "Schůzka s klientem", startMinutes: 600, endMinutes: 690, place: "Kancelář, Karlín",
                projectColor: "#AF52DE", hasTranscript: true
            ),
            onOpen: {}
        )
        JournalBirthdayRow(birthday: JournalBirthday(id: "b", personName: "Jana Kovářová"))
        JournalInboxRow(
            item: JournalInboxItem(
                id: "i", time: "18:02", text: "Faktura za obklady", emoji: "💸", status: .proposed,
                attachmentName: "Fotka 18:02", attachmentCount: 1
            )
        )
    }
    .padding()
}
