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
    /// The focus of the notes on the pages beside the one in view, which nobody edits until they come into view.
    @StateObject private var asideFocus = NoteEditorFocus()
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
    @State private var pageScroll = PaperScroll()
    /// The state the page's cards keep while the axis moves, and whether a turn of the page is under way.
    @State private var hold = JournalPageHold()
    /// The turn of the page a period of the selected kind picked on the axis asks for.
    @State private var turnRequest: JournalPageTurnRequest?
    /// Counts the changes of the selected period and the presses of Today, for their haptics, as in the calendar: a
    /// new period ticks, Today taps softly, and the period Today brings does not tick again.
    @State private var selectionTicks = 0
    @State private var todayTaps = 0
    @State private var todayBrings: JournalSelection?

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
                PaperBackground(scroll: pageScroll)
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
            // Today floats at the bottom leading edge, where the calendar has its own.
            .safeAreaInset(edge: .bottom) {
                if case .content = viewModel.state.phase, !noteFocus.isActive { todayBar }
            }
            .sensoryFeedback(.selection, trigger: selectionTicks)
            .sensoryFeedback(.impact(flexibility: .soft), trigger: todayTaps)
            // A turn ends once its period is shown, unless the axis still moves to it (then it ends when the axis
            // rests): a period picked that the axis already shows moves nothing.
            .onChange(of: viewModel.state.shown) { _, _ in
                hold.periodShown(axisMoving: axisMotion.driver != nil)
            }
            .onChange(of: viewModel.state.selection) { _, selection in
                if selection == todayBrings { todayBrings = nil } else { selectionTicks += 1 }
            }
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension JournalScreen {

    /// The room above the axis, under the top of the screen.
    var titleRow: some View { Color.clear.frame(height: Theme.Spacing.small) }

    /// Today, as the calendar's, at the bottom leading edge.
    var todayBar: some View {
        JournalTodayBar {
            todayTaps += 1
            // Today on today only scrolls back to it; another day scrolls there once it is selected.
            let state = viewModel.state
            let today = JournalSelection(kind: .day, start: state.today)
            if state.selection == today {
                axisMotion.centerRequests += 1
            } else {
                todayBrings = today
                // From another day the page turns to today from its side, as a swipe or a day picked on the axis
                // turns it; from a week, a month or a year it changes in place.
                if let request = JournalPageTurnRequest(
                    to: today,
                    from: state.selection,
                    after: turnRequest,
                    leaving: pageState
                ) {
                    hold.turnStarted()
                    turnRequest = request
                }
            }
            viewModel.goToday()
        }
    }

    /// Selects the period `steps` away from the selected one, as a swipe of the page turns to it. The page that comes
    /// shows the new period as soon as it comes, the axis moving or not.
    func turn(_ steps: Int) -> JournalSelection? {
        guard let target = viewModel.turn(by: steps) else { return nil }
        hold.turnStarted()
        return target
    }

    /// A period picked on the axis. One of the selected kind turns the page to its side, as a swipe does.
    func pick(_ cell: JournalAxisCell) {
        if let request = JournalPageTurnRequest(
            picking: cell,
            from: viewModel.state.selection,
            after: turnRequest,
            leaving: pageState
        ) {
            hold.turnStarted()
            turnRequest = request
        }
        viewModel.select(cell)
    }

    /// The axis started or stopped moving: the page's cards wait for it to rest, unless the page turns.
    func axisMoved(_ moving: Bool) {
        hold.axisMoved(moving, showing: viewModel.state)
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
            onSelect: pick,
            onMove: viewModel.showAxis(around:),
            onMoving: axisMoved,
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
                    // While a note is focused only the page stays; it stays the same view, so the note being edited
                    // is never made again under the person's cursor.
                    if !noteFocus.isActive {
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
                    }
                    JournalPager(
                        current: pageState,
                        isEnabled: !noteFocus.isActive,
                        request: turnRequest,
                        onTurn: turn,
                        page: { state, inView in page(state, inView: inView) }
                    )
                    .padding(.top, noteFocus.isActive ? Theme.Spacing.small : Theme.Spacing.medium)
                }
                .padding(.bottom, Theme.Spacing.large)
                // Room for the selected row to reach the top; a focused note has no axis to pin.
                .frame(minHeight: noteFocus.isActive ? 0 : viewportHeight + pinnedOffset, alignment: .top)
            }
            // As in Notes, the page pulled down takes the keyboard with it, which ends writing in the note.
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(
                for: CGFloat.self,
                // The container is already the visible height, inside the bars' insets.
                of: { $0.containerSize.height },
                action: { _, height in viewportHeight = height }
            )
            .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentInsets.top }, action: { _, top in
                contentTop = top
            })
            .paperScroll(pageScroll)
        }
    }

    /// The cards of a period, from `state`; only the page in view tells the screen when its note is edited.
    func page(_ state: JournalState, inView: Bool) -> some View {
        JournalPageView(
            state: state,
            notes: notes,
            focus: inView ? noteFocus : asideFocus,
            capture: capture,
            flippedSections: $flippedSections,
            onOpenEvent: viewModel.openEvent,
            onOpenInbox: viewModel.openInbox,
            onCaptured: viewModel.retry
        )
    }

    /// What the page's cards show: the diary's state, or while the axis moves the state it had when it started to.
    var pageState: JournalState { hold.held ?? viewModel.state }

    /// The space between two rows of the axis.
    static var axisRowSpacing: CGFloat { 2 }
    /// How far the axis's material reaches past the top of the screen, so no scroll ever shows its upper edge.
    static var materialOverreach: CGFloat { 40 }
}
