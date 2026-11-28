import CoreKit
import DesignSystem
import NoteEditor
import SwiftUI

/// The cards of one period of the diary, from the state given: a day shows its week, events, Inbox and note; a month
/// lists its weeks; a year shows its note and lists its quarters. While a turn of the page goes on, two of these lie
/// side by side, the page leaving with the state it had and the page coming with the diary's.
struct JournalPageView: View {

    // MARK: - Dependencies
    let state: JournalState
    let notes: JournalNotes
    let focus: NoteEditorFocus
    @ObservedObject var capture: JournalCaptureViewModel
    /// The weeks and quarters, by their period key, whose open state the person flipped from what the page shows by
    /// default.
    @Binding var flippedSections: Set<String>
    let onOpenEvent: (JournalEvent) -> Void
    /// The id of the Inbox attachment being made ready to preview.
    let openingAttachment: String?
    let onOpenAttachment: (JournalInboxItem, InboxAttachment) -> Void
    let onOpenInbox: () -> Void
    let onCaptured: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            header
            switch shownPeriod.kind {
            case .day: dayContent
            case .month: monthContent
            case .year: yearContent
            case .quarter, .week: periodNote
            }
        }
        .padding(.horizontal, Theme.Spacing.medium)
    }
}

// MARK: - Subviews
private extension JournalPageView {

    /// What the longer periods are, under the bar; a day's heading says all in the bar.
    @ViewBuilder var header: some View {
        if shownPeriod.kind != .day {
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.horizontal, 4)
        }
    }

    // MARK: Day
    @ViewBuilder var dayContent: some View {
        if let week = state.weeks.first {
            weekCard(week, openByDefault: false)
        }
        eventsSection
        inboxSection
        if let page = state.page {
            section(Text("journal.notes", bundle: .module)) {
                notes.editor(page, focus: focus)
            }
        }
    }

    var eventsSection: some View {
        let events = state.events
        let birthdays = state.birthdays
        return section(Text("journal.events", bundle: .module), count: events.count) {
            if events.isEmpty && birthdays.isEmpty {
                Text("journal.events.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            } else {
                ForEach(birthdays) { birthday in
                    JournalBirthdayRow(birthday: birthday)
                    if birthday.id != birthdays.last?.id || !events.isEmpty { rowDivider }
                }
                ForEach(events) { event in
                    JournalEventRow(event: event) { onOpenEvent(event) }
                    if event.id != events.last?.id { rowDivider }
                }
            }
        }
    }

    @ViewBuilder var inboxSection: some View {
        let items = state.inbox
        // Today always has the Inbox, because that is where something new is written down.
        let isToday = shownPeriod.start == state.today
        if !items.isEmpty || isToday {
            section(Text("journal.inbox", bundle: .module), count: items.count, trailing: {
                Button(action: onOpenInbox) {
                    Text("journal.inbox.process", bundle: .module)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                }
                .journalAccentGlass()
                .accessibilityIdentifier(JournalIdentifiers.inboxProcess)
            }, content: {
                ForEach(items) { item in
                    JournalInboxRow(item: item, openingAttachment: openingAttachment) { attachment in
                        onOpenAttachment(item, attachment)
                    }
                    if item.id != items.last?.id || isToday { rowDivider }
                }
                if isToday {
                    JournalCaptureRow(viewModel: capture, day: state.today)
                }
            })
            .onChange(of: capture.captured) { _, _ in onCaptured() }
        }
    }

    // MARK: Month
    var monthContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            ForEach(state.weeks) { week in
                weekCard(week, openByDefault: week.contains(day: state.today))
            }
        }
    }

    // MARK: Year
    var yearContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            periodNote
            ForEach(state.quarters) { quarter in
                quarterCard(quarter)
            }
        }
    }

    // MARK: Own note
    @ViewBuilder var periodNote: some View {
        if let page = state.page {
            card { notes.editor(page, focus: focus) }
        }
    }

    // MARK: Pieces
    func weekCard(_ week: JournalWeek, openByDefault: Bool) -> some View {
        collapsibleCard(
            page: week.page,
            title: String(format: String(localized: "journal.week", bundle: .module), week.number),
            span: JournalDates.weekRange(first: week.firstDay, last: week.lastDay),
            openByDefault: openByDefault,
            identifier: JournalIdentifiers.weekTogglePrefix + String(week.number)
        )
    }

    /// A quarter of the shown year, open by default when it holds today.
    func quarterCard(_ quarter: JournalQuarter) -> some View {
        collapsibleCard(
            page: quarter.page,
            title: String(format: String(localized: "journal.quarter", bundle: .module), quarter.number),
            span: JournalDates.quarterSpan(start: quarter.firstDay),
            openByDefault: quarter.firstDay <= state.today && state.today <= quarter.lastDay,
            identifier: JournalIdentifiers.quarterTogglePrefix + String(quarter.number)
        )
    }

    /// A card of a week or a quarter: its title and days in a row that opens and closes its note.
    func collapsibleCard(
        page: JournalPage,
        title: String,
        span: String,
        openByDefault: Bool,
        identifier: String
    ) -> some View {
        let isOpen = flippedSections.contains(page.ref.period) != openByDefault
        return VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Button { toggle(page.ref.period) } label: {
                HStack(spacing: Theme.Spacing.medium) {
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(title).font(.title3.weight(.bold))
                    Spacer(minLength: 0)
                    Text(span)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(isOpen ? "journal.week.expanded" : "journal.week.collapsed", bundle: .module))
            .accessibilityIdentifier(identifier)
            if isOpen {
                notes.editor(page, focus: focus)
            }
        }
        .padding(.horizontal, Theme.Spacing.medium + 4)
        .padding(.vertical, Theme.Spacing.medium)
        .journalCard()
    }

    func toggle(_ period: String) {
        if flippedSections.contains(period) {
            flippedSections.remove(period)
        } else {
            flippedSections.insert(period)
        }
    }
}

// MARK: - Titles
private extension JournalPageView {

    /// The period the cards belong to: while a new selection loads, still the one shown before, so its content keeps
    /// its own layout and subtitle.
    var shownPeriod: JournalSelection { state.shown ?? state.selection }

    var subtitle: String {
        switch shownPeriod.kind {
        case .day, .week:
            let year = JournalDates.year(shownPeriod.start)
            let key = shownPeriod.start == state.today ? "journal.subtitle.dayToday" : "journal.subtitle.day"
            return String(format: String(localized: String.LocalizationValue(key), bundle: .module), year)
        case .month: return String(localized: "journal.subtitle.month", bundle: .module)
        case .quarter: return JournalDates.quarterSpan(start: shownPeriod.start)
        case .year: return String(localized: "journal.subtitle.year", bundle: .module)
        }
    }
}
