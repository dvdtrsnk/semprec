import CoreKit
import DesignSystem
import NoteEditor
import SwiftUI

/// The diary: a time axis of years, quarters, months and days, and below it the note of the selected period. A day
/// also shows its week, events, Inbox and note; a month lists its weeks. Each note is edited in the light note
/// editor, which writes it itself. The whole page scrolls over the diary's gradient, the heading and the Today button
/// with it; only the axis row of the selected level stays at the top, on glass, with the page passing under it.
struct JournalScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: JournalViewModel
    @StateObject private var capture: JournalCaptureViewModel
    /// Set while a note is edited or its blocks are selected: the diary then shows only the page, and a check ends it.
    @StateObject private var noteFocus = NoteEditorFocus()
    private let notes: JournalNotes

    // MARK: - State
    /// Weeks whose open state the person flipped from what the screen shows by default.
    @State private var flippedWeeks: Set<Int> = []
    /// Where the axis stands, shared by its rows that scroll and its row that stays.
    @State private var axisMotion = JournalAxisMotion()
    /// How tall the heading and the rows above the selected level are, and the visible height of the page: the page
    /// is at least so tall that it scrolls far enough for the selected row to reach the top.
    @State private var aboveHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    /// The size of the whole page, the top of its safe area and the frame of the selected axis row, on screen: the
    /// band behind that row shows as the row comes up to the top.
    @State private var pageSize: CGSize = .zero
    @State private var safeTop: CGFloat = 0
    @State private var pinnedFrame: CGRect = .zero
    /// How far the page is scrolled from its top, up to a screen's height: the gradient at the top of the page moves
    /// with it and is gone beyond that.
    @State private var scrolled: CGFloat = 0

    // MARK: - Init
    init(
        viewModel: @autoclosure @escaping () -> JournalViewModel,
        capture: @autoclosure @escaping () -> JournalCaptureViewModel,
        notes: JournalNotes
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        _capture = StateObject(wrappedValue: capture())
        self.notes = notes
    }

    // MARK: - Body
    var body: some View {
        content
            .background {
                JournalBackground(scrolled: scrolled)
                    .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { pageSize = $0 })
            }
            .background {
                Color.clear
                    .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { safeTop = $0 })
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(JournalIdentifiers.screen)
            .navigationTitle(Text("journal.title", bundle: .module))
            // The page draws its own heading; the navigation bar returns only for the check that ends a focused note.
            .journalNavigationBar(hidden: !noteFocus.isActive)
            .toolbar {
                if noteFocus.isActive {
                    ToolbarItem(placement: .primaryAction) { NoteFocusDoneButton(focus: noteFocus) }
                }
            }
            .animation(.snappy(duration: 0.3), value: noteFocus.isActive)
            .noteFormatBar(noteFocus)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension JournalScreen {

    var titleRow: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.medium) {
            Spacer(minLength: 0)
            Button(action: viewModel.goToday) {
                Text("journal.today", bundle: .module)
                    .font(.headline)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
            }
            .journalAccentGlass()
            .accessibilityIdentifier(JournalIdentifiers.today)
        }
        .padding(.horizontal, Theme.Spacing.medium + 4)
        .padding(.top, Theme.Spacing.small)
        .padding(.bottom, Theme.Spacing.small)
    }

    /// The axis rows above, of and below the selected level.
    var axisLevels: (upper: [JournalAxisRow], selected: [JournalAxisRow], lower: [JournalAxisRow]) {
        let rows = viewModel.state.axis
        guard let index = rows.firstIndex(where: { $0.kind == viewModel.state.selection.kind }) else {
            return (rows, [], [])
        }
        return (Array(rows[..<index]), [rows[index]], Array(rows[(index + 1)...]))
    }

    func axis(_ shown: [JournalAxisRow]) -> some View {
        JournalAxisView(
            rows: viewModel.state.axis,
            shown: shown,
            selectionStart: viewModel.state.selection.start,
            selectionKind: viewModel.state.selection.kind,
            onSelect: viewModel.select,
            onMove: viewModel.showAxis(around:),
            motion: $axisMotion
        )
    }

    /// The selected level's row: its glass capsules stay at the top while the page passes under them.
    var pinnedRow: some View {
        axis(axisLevels.selected)
            .padding(.vertical, Self.axisRowSpacing)
            .background(alignment: .top) {
                JournalTopBand(pageSize: pageSize, solidHeight: pinnedFrame.maxY, scrolled: scrolled)
                    .offset(y: -pinnedFrame.minY)
                    .opacity(bandOpacity)
            }
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }, action: { pinnedFrame = $0 })
    }

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        case .content:
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                    if noteFocus.isActive {
                        page.padding(.top, Theme.Spacing.small)
                    } else {
                        VStack(spacing: Self.axisRowSpacing) {
                            titleRow
                            axis(axisLevels.upper)
                        }
                        .onGeometryChange(
                            for: CGFloat.self,
                            of: { $0.size.height },
                            action: { aboveHeight = $0 }
                        )
                        Section {
                            axis(axisLevels.lower)
                            page.padding(.top, Theme.Spacing.medium)
                        } header: {
                            pinnedRow
                        }
                    }
                }
                .padding(.bottom, Theme.Spacing.large)
                .frame(minHeight: viewportHeight + aboveHeight, alignment: .top)
            }
            .onScrollGeometryChange(
                for: CGFloat.self,
                of: { $0.containerSize.height - $0.contentInsets.top - $0.contentInsets.bottom },
                action: { _, height in viewportHeight = height }
            )
            .onScrollGeometryChange(
                for: CGFloat.self,
                of: { min(max($0.contentOffset.y + $0.contentInsets.top, 0), $0.containerSize.height) },
                action: { _, offset in scrolled = offset }
            )
        }
    }

    /// The band behind the selected row comes in over the last row's height before the row reaches the top, so the
    /// rows passing above it go under the band and the page never shows through the row once it stays there.
    var bandOpacity: Double {
        guard pinnedFrame.height > 0 else { return 0 }
        let distance = pinnedFrame.minY - safeTop
        return min(max(1 - distance / pinnedFrame.height, 0), 1)
    }

    /// The cards of the selected period.
    var page: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            header
            switch viewModel.state.selection.kind {
            case .day: dayContent
            case .month: monthContent
            case .quarter, .year, .week: periodNote
            }
        }
        .padding(.horizontal, Theme.Spacing.medium)
    }

    /// The space between two rows of the axis.
    static var axisRowSpacing: CGFloat { 2 }

    /// What the longer periods are, under the bar; a day's heading says all in the bar.
    @ViewBuilder var header: some View {
        if viewModel.state.selection.kind != .day {
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.horizontal, 4)
        }
    }

    // MARK: Day
    @ViewBuilder var dayContent: some View {
        if let week = viewModel.state.weeks.first {
            weekCard(week, openByDefault: false)
        }
        eventsSection
        inboxSection
        if let page = viewModel.state.page {
            section(Text("journal.notes", bundle: .module)) {
                notes.editor(page, focus: noteFocus)
            }
        }
    }

    var eventsSection: some View {
        let events = viewModel.state.events
        let birthdays = viewModel.state.birthdays
        return section(Text("journal.events", bundle: .module), count: events.count) {
            if events.isEmpty && birthdays.isEmpty {
                Text("journal.events.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            } else {
                ForEach(birthdays) { birthday in
                    JournalBirthdayRow(birthday: birthday)
                    if birthday.id != birthdays.last?.id || !events.isEmpty { rowDivider }
                }
                ForEach(events) { event in
                    JournalEventRow(event: event) { viewModel.openEvent(event) }
                    if event.id != events.last?.id { rowDivider }
                }
            }
        }
    }

    @ViewBuilder var inboxSection: some View {
        let items = viewModel.state.inbox
        // Today always has the Inbox, because that is where something new is written down.
        let isToday = viewModel.state.selection.start == viewModel.state.today
        if !items.isEmpty || isToday {
            section(Text("journal.inbox", bundle: .module), count: items.count, trailing: {
                Button(action: viewModel.openInbox) {
                    Text("journal.inbox.process", bundle: .module)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                }
                .journalAccentGlass()
                .accessibilityIdentifier(JournalIdentifiers.inboxProcess)
            }, content: {
                ForEach(items) { item in
                    JournalInboxRow(item: item)
                    if item.id != items.last?.id || isToday { rowDivider }
                }
                if isToday {
                    JournalCaptureRow(viewModel: capture, day: viewModel.state.today)
                }
            })
            .onChange(of: capture.captured) { _, _ in viewModel.retry() }
        }
    }

    // MARK: Month
    var monthContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            ForEach(viewModel.state.weeks) { week in
                weekCard(week, openByDefault: week.contains(day: viewModel.state.today))
            }
        }
    }

    // MARK: Quarter and year
    @ViewBuilder var periodNote: some View {
        if let page = viewModel.state.page {
            card { notes.editor(page, focus: noteFocus) }
        }
    }

    // MARK: Pieces
    func weekCard(_ week: JournalWeek, openByDefault: Bool) -> some View {
        let isOpen = flippedWeeks.contains(week.number) != openByDefault
        return VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Button { toggle(week) } label: {
                HStack(spacing: Theme.Spacing.medium) {
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(weekTitle(week)).font(.title3.weight(.bold))
                    Spacer(minLength: 0)
                    Text(JournalDates.weekRange(first: week.firstDay, last: week.lastDay))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(isOpen ? "journal.week.expanded" : "journal.week.collapsed", bundle: .module))
            .accessibilityIdentifier(JournalIdentifiers.weekTogglePrefix + String(week.number))
            if isOpen {
                notes.editor(week.page, focus: noteFocus)
            }
        }
        .padding(.horizontal, Theme.Spacing.medium + 4)
        .padding(.vertical, Theme.Spacing.medium)
        .journalCard()
    }

    func toggle(_ week: JournalWeek) {
        if flippedWeeks.contains(week.number) {
            flippedWeeks.remove(week.number)
        } else {
            flippedWeeks.insert(week.number)
        }
    }

    func weekTitle(_ week: JournalWeek) -> String {
        String(format: String(localized: "journal.week", bundle: .module), week.number)
    }
}

// MARK: - Titles
private extension JournalScreen {

    var selection: JournalSelection { viewModel.state.selection }

    var subtitle: String {
        switch selection.kind {
        case .day, .week:
            let year = JournalDates.year(selection.start)
            let key = selection.start == viewModel.state.today ? "journal.subtitle.dayToday" : "journal.subtitle.day"
            return String(format: String(localized: String.LocalizationValue(key), bundle: .module), year)
        case .month: return String(localized: "journal.subtitle.month", bundle: .module)
        case .quarter: return JournalDates.quarterSpan(start: selection.start)
        case .year: return String(localized: "journal.subtitle.year", bundle: .module)
        }
    }
}

private extension JournalWeek {

    /// Whether `day` (`YYYY-MM-DD`) is one of the week's days; days in this form order as text.
    func contains(day: String) -> Bool {
        firstDay <= day && day <= lastDay
    }
}
