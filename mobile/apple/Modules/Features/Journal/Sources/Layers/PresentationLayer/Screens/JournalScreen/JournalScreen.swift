import CoreKit
import DesignSystem
import SwiftUI

/// The diary: a time axis of years, quarters, months and days, and below it the note of the selected period. A day
/// also shows its week, events, Inbox and note; a month lists its weeks. Every change to a note goes to the shared
/// ViewModel, which writes it through the page API.
struct JournalScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: JournalViewModel

    // MARK: - State
    /// How far the page is scrolled, which folds the rows of the axis away.
    @State private var scrolled: CGFloat = 0
    /// The visible height of the page between its margins; the axis does not change it.
    @State private var viewportHeight: CGFloat = 0
    /// Weeks whose open state the person flipped from what the screen shows by default.
    @State private var flippedWeeks: Set<Int> = []

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> JournalViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(JournalIdentifiers.screen)
            .navigationTitle(Text("journal.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: viewModel.goToday) { Text("journal.today", bundle: .module) }
                        .accessibilityIdentifier(JournalIdentifiers.today)
                }
            }
            // An overlay, not a safe area inset: the axis folds while the page scrolls, and an inset that changed with
            // it would move the page and the fold again, without end. The page keeps room for the whole axis instead.
            .overlay(alignment: .top) {
                JournalAxisView(
                    rows: viewModel.state.axis,
                    selectionStart: viewModel.state.selection.start,
                    selectionKind: viewModel.state.selection.kind,
                    scrolled: scrolled,
                    onSelect: viewModel.select,
                    onMove: viewModel.showAxis(around:)
                )
                .padding(.vertical, Self.axisPadding)
                .background(.bar)
            }
            .safeAreaInset(edge: .bottom) {
                if let problem = viewModel.state.editProblem {
                    JournalProblemBanner(
                        problem: problem,
                        onReload: viewModel.retry,
                        onDismiss: viewModel.dismissProblem
                    )
                }
            }
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension JournalScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.message(for: failure)), retry: viewModel.retry))
        case .content:
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                    header
                    switch viewModel.state.selection.kind {
                    case .day: dayContent
                    case .month: monthContent
                    case .quarter, .year, .week: periodNote
                    }
                }
                .padding(Theme.Spacing.medium)
                // Taller than the visible page by the rows that fold, so even a short page scrolls far enough to fold
                // the axis away.
                .frame(minHeight: viewportHeight + JournalAxisView.foldingHeight(
                    of: viewModel.state.axis,
                    selected: viewModel.state.selection.kind
                ), alignment: .top)
            }
            .background(Theme.Colors.groupedBackground)
            .contentMargins(.bottom, bottomRoom, for: .scrollContent)
            .contentMargins(
                .top,
                JournalAxisView.height(of: viewModel.state.axis) + Self.axisPadding * 2,
                for: .scrollContent
            )
            .onScrollGeometryChange(
                for: CGFloat.self,
                of: { min(max($0.contentOffset.y + $0.contentInsets.top, 0), Self.foldDistance) },
                action: { _, offset in scrolled = offset }
            )
            .onScrollGeometryChange(
                for: CGFloat.self,
                of: { $0.containerSize.height },
                action: { _, height in viewportHeight = height }
            )
        }
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.largeTitle.bold())
            Text(subtitle).foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                editor(page, placeholder: "journal.placeholder.day")
            }
        }
    }

    var eventsSection: some View {
        let events = viewModel.state.events
        let birthdays = viewModel.state.birthdays
        return section(
            Text("journal.events", bundle: .module),
            count: events.count
        ) {
            if events.isEmpty && birthdays.isEmpty {
                Text("journal.events.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            } else {
                card {
                    ForEach(birthdays) { birthday in
                        JournalBirthdayRow(birthday: birthday)
                        if birthday.id != birthdays.last?.id || !events.isEmpty { Divider() }
                    }
                    ForEach(events) { event in
                        JournalEventRow(event: event) { viewModel.openEvent(event) }
                        if event.id != events.last?.id { Divider() }
                    }
                }
            }
        }
    }

    @ViewBuilder var inboxSection: some View {
        let items = viewModel.state.inbox
        if !items.isEmpty {
            section(Text("journal.inbox", bundle: .module), count: items.count, trailing: {
                Button(action: viewModel.openInbox) { Text("journal.inbox.process", bundle: .module) }
                    .accessibilityIdentifier(JournalIdentifiers.inboxProcess)
            }, content: {
                card {
                    ForEach(items) { item in
                        JournalInboxRow(item: item)
                        if item.id != items.last?.id { Divider() }
                    }
                }
            })
        }
    }

    // MARK: Month
    var monthContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            ForEach(viewModel.state.weeks) { week in
                weekCard(week, openByDefault: week.contains(day: viewModel.state.today))
            }
        }
    }

    // MARK: Quarter and year
    @ViewBuilder var periodNote: some View {
        if let page = viewModel.state.page {
            card { editor(page, placeholder: placeholderKey) }
        }
    }

    // MARK: Pieces
    func weekCard(_ week: JournalWeek, openByDefault: Bool) -> some View {
        let isOpen = flippedWeeks.contains(week.number) != openByDefault
        return VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Button { toggle(week) } label: {
                HStack(spacing: Theme.Spacing.small) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(isOpen ? 90 : 0)).font(.footnote)
                    Text(weekTitle(week)).fontWeight(.semibold)
                    Text(JournalDates.weekRange(first: week.firstDay, last: week.lastDay))
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(isOpen ? "journal.week.expanded" : "journal.week.collapsed", bundle: .module))
            .accessibilityIdentifier(JournalIdentifiers.weekTogglePrefix + String(week.number))
            if isOpen {
                editor(week.page, placeholder: "journal.placeholder.week")
            }
        }
        .padding(Theme.Spacing.medium)
        .background(Theme.Colors.card, in: .rect(cornerRadius: 16))
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

    func editor(_ page: JournalPage, placeholder: String) -> some View {
        JournalPageEditor(
            identifierPrefix: page.ref.period,
            blocks: page.blocks,
            placeholder: String(localized: String.LocalizationValue(placeholder), bundle: .module),
            saving: viewModel.state.saving,
            hasProblem: viewModel.state.editProblem != nil,
            onSetText: { viewModel.setText(page: page.ref, index: $0, text: $1) },
            onToggle: { viewModel.toggleDone(page: page.ref, index: $0) },
            onAdd: { viewModel.addBlock(page: page.ref, kind: $0, text: $1) },
            onOpenPage: { viewModel.openPage(pageId: $0, title: $1) }
        )
    }

    func section<Content: View>(
        _ title: Text,
        count: Int? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        section(title, count: count, trailing: { EmptyView() }, content: content)
    }

    func section<Trailing: View, Content: View>(
        _ title: Text,
        count: Int? = nil,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack {
                title.font(.title3.weight(.semibold))
                if let count { Text(String(count)).foregroundStyle(Theme.Colors.secondaryText) }
                Spacer(minLength: 0)
                trailing()
            }
            content()
        }
    }

    func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) { content() }
            .padding(Theme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.card, in: .rect(cornerRadius: 16))
    }

    /// Room under the page, as in the design, so that even a short page scrolls far enough to fold the axis away.
    var bottomRoom: CGFloat {
        viewModel.state.selection.kind == .day ? 140 : 520
    }

    /// The space above and below the rows of the axis.
    static var axisPadding: CGFloat { 4 }

    /// Scrolling beyond this no longer changes the axis, so the page stops updating it there.
    static var foldDistance: CGFloat { 200 }
}

// MARK: - Titles
private extension JournalScreen {

    var selection: JournalSelection { viewModel.state.selection }

    var title: String {
        switch selection.kind {
        case .day, .week: JournalDates.dayTitle(selection.start)
        case .month: JournalDates.monthTitle(selection.start)
        case .quarter: JournalDates.quarterTitle(start: selection.start)
        case .year: String(JournalDates.year(selection.start))
        }
    }

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

    var placeholderKey: String {
        selection.kind == .quarter ? "journal.placeholder.quarter" : "journal.placeholder.year"
    }
}

private extension JournalWeek {

    /// Whether `day` (`YYYY-MM-DD`) is one of the week's days; days in this form order as text.
    func contains(day: String) -> Bool {
        firstDay <= day && day <= lastDay
    }
}

// MARK: - Preview
#Preview("Day") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: .previewDay),
            router: PreviewJournalRouter()
        ))
    }
}

#Preview("Loading") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: JournalState(
                phase: .loading, selection: .previewDay, today: "2026-10-16", axis: .previewAxis
            )),
            router: PreviewJournalRouter()
        ))
    }
}

#Preview("Unavailable") {
    NavigationStack {
        JournalScreen(viewModel: JournalViewModel(
            model: ScriptedJournalScreenModel(state: JournalState(
                phase: .failure(.unavailable), selection: .previewDay, today: "2026-10-16", axis: .previewAxis
            )),
            router: PreviewJournalRouter()
        ))
    }
}
