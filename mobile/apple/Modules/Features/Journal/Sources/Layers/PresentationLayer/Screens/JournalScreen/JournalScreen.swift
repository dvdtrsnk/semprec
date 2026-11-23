import CoreKit
import DesignSystem
import NoteEditor
import SwiftUI

/// The diary: a time axis of years, months and days, and below it the note of the selected period. A day also shows
/// its week, events, Inbox and note; a month lists its weeks; a year shows its note and lists its quarters. Each note
/// is edited in the light note editor, which writes it itself. The whole page scrolls over the diary's gradient, the
/// heading and the Today button with it; the axis lies on a solid material that ends in a divider, and only the axis
/// row of the selected level stays at the top, with the page passing under it. While the page scrolls, only the
/// background redraws: it reads the scroll from `pageScroll`, which the screen itself never reads.
struct JournalScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: JournalViewModel
    @StateObject private var capture: JournalCaptureViewModel
    /// Set while a note is edited or its blocks are selected: the diary then shows only the page, and a check ends it.
    @StateObject private var noteFocus = NoteEditorFocus()
    private let notes: JournalNotes

    // MARK: - State
    /// The weeks and quarters, by their period key, whose open state the person flipped from what the screen shows by
    /// default.
    @State private var flippedSections: Set<String> = []
    /// Where the axis stands, shared by its three rows.
    @State private var axisMotion = JournalAxisMotion()
    /// How tall the heading is and the visible height of the page: the page is at least so tall that it scrolls far
    /// enough for the selected row to reach the top. The axis's material reaches up over the heading and the top inset
    /// of the content.
    @State private var titleHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var contentTop: CGFloat = 0
    /// How far the page is scrolled and how large it is, for the background and the band behind the pinned row.
    @State private var pageScroll = JournalPageScroll()
    /// The state the page's cards show while the axis moves: the cards of a new selection are built once the axis
    /// comes to rest, so building them never takes a frame from the axis's scroll.
    @State private var heldState: JournalState?

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
                JournalBackground(scroll: pageScroll)
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
            Button {
                // Today on today only scrolls back to it; another day scrolls there once it is selected.
                let state = viewModel.state
                if state.selection == JournalSelection(kind: .day, start: state.today) {
                    axisMotion.centerRequests += 1
                }
                viewModel.goToday()
            } label: {
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

    /// How far down the page the selected row is: below the heading and the rows above it.
    var pinnedOffset: CGFloat {
        let rows = viewModel.state.axis
        let above = rows.prefix { $0.kind != viewModel.state.selection.kind }
        return titleHeight + above.reduce(0) { $0 + $1.kind.height + Self.axisRowSpacing }
    }

    var axis: some View {
        JournalAxisView(
            rows: viewModel.state.axis,
            selectionStart: viewModel.state.selection.start,
            selectionKind: viewModel.state.selection.kind,
            materialReach: contentTop + titleHeight + Self.materialOverreach,
            onSelect: viewModel.select,
            onMove: viewModel.showAxis(around:),
            onMoving: { moving in heldState = moving ? viewModel.state : nil },
            material: { JournalHeaderMaterial() },
            motion: $axisMotion
        )
    }

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        case .content:
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if noteFocus.isActive {
                        page.padding(.top, Theme.Spacing.small)
                    } else {
                        titleRow
                            .padding(.bottom, Self.axisRowSpacing)
                            .onGeometryChange(
                                for: CGFloat.self,
                                of: { $0.size.height },
                                action: { titleHeight = $0 }
                            )
                            // The material over the top of the screen, above the content's top inset: what scrolls up
                            // there goes under it, as under a bar.
                            .overlay(alignment: .top) {
                                JournalHeaderMaterial()
                                    .frame(height: contentTop + Self.materialOverreach)
                                    .alignmentGuide(.top) { $0[.bottom] }
                                    .keptAtTop()
                            }
                            .zIndex(2)
                        axis.zIndex(1)
                        page.padding(.top, Theme.Spacing.medium)
                    }
                }
                .padding(.bottom, Theme.Spacing.large)
                .frame(minHeight: viewportHeight + pinnedOffset, alignment: .top)
            }
            .onScrollGeometryChange(
                for: CGFloat.self,
                // The container is already the visible height, inside the bars' insets.
                of: { $0.containerSize.height },
                action: { _, height in viewportHeight = height }
            )
            .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentInsets.top }, action: { _, top in
                contentTop = top
            })
            .onScrollGeometryChange(
                for: CGFloat.self,
                of: { min(max($0.contentOffset.y + $0.contentInsets.top, 0), $0.containerSize.height) },
                action: { _, offset in pageScroll.offset = offset }
            )
        }
    }

    /// The cards of the selected period.
    var page: some View {
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

    /// The space between two rows of the axis.
    static var axisRowSpacing: CGFloat { 2 }
    /// How far the axis's material reaches past the top of the screen, so no scroll ever shows its upper edge.
    static var materialOverreach: CGFloat { 40 }

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
        if let week = pageState.weeks.first {
            weekCard(week, openByDefault: false)
        }
        eventsSection
        inboxSection
        if let page = pageState.page {
            section(Text("journal.notes", bundle: .module)) {
                notes.editor(page, focus: noteFocus)
            }
        }
    }

    var eventsSection: some View {
        let events = pageState.events
        let birthdays = pageState.birthdays
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
        let items = pageState.inbox
        // Today always has the Inbox, because that is where something new is written down.
        let isToday = shownPeriod.start == pageState.today
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
                    JournalCaptureRow(viewModel: capture, day: pageState.today)
                }
            })
            .onChange(of: capture.captured) { _, _ in viewModel.retry() }
        }
    }

    // MARK: Month
    var monthContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            ForEach(pageState.weeks) { week in
                weekCard(week, openByDefault: week.contains(day: pageState.today))
            }
        }
    }

    // MARK: Year
    var yearContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            periodNote
            ForEach(pageState.quarters) { quarter in
                quarterCard(quarter)
            }
        }
    }

    // MARK: Own note
    @ViewBuilder var periodNote: some View {
        if let page = pageState.page {
            card { notes.editor(page, focus: noteFocus) }
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
            openByDefault: quarter.firstDay <= pageState.today && pageState.today <= quarter.lastDay,
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
                notes.editor(page, focus: noteFocus)
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
private extension JournalScreen {

    /// The period the cards belong to: while a new selection loads, still the one shown before, so its content keeps
    /// its own layout and subtitle.
    var shownPeriod: JournalSelection { pageState.shown ?? pageState.selection }

    /// What the page's cards show: the diary's state, or while the axis moves the state it had when it started to.
    var pageState: JournalState { heldState ?? viewModel.state }

    var subtitle: String {
        switch shownPeriod.kind {
        case .day, .week:
            let year = JournalDates.year(shownPeriod.start)
            let key = shownPeriod.start == pageState.today ? "journal.subtitle.dayToday" : "journal.subtitle.day"
            return String(format: String(localized: String.LocalizationValue(key), bundle: .module), year)
        case .month: return String(localized: "journal.subtitle.month", bundle: .module)
        case .quarter: return JournalDates.quarterSpan(start: shownPeriod.start)
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
