import CoreKit
import SwiftUI

/// One day: the week strip, the date, the row of all-day items and the timeline. Every gesture reports where the
/// finger is; this view turns that into raw minutes of the day and the shared ViewModel decides what they mean.
struct CalendarDayView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel

    // MARK: - State
    @State private var contentFrame = CGRect.zero
    @State private var viewportFrame = CGRect.zero
    @State private var eventFrames: [String: CGRect] = [:]
    @State private var lastAutoScroll = Date.distantPast
    /// The day the pages are laid out around; moved when the pager nears either end.
    @State private var anchorDay: String?
    /// The day of the page the pager shows or settles on.
    @State private var visibleDay: String?
    /// The day a settled swipe asked for, until the selected day becomes it.
    @State private var requestedDay: String?
    @State private var phase = ScrollPhase.idle

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            CalendarWeekStrip(
                selectedDay: state.selectedDay,
                today: state.today,
                onPick: { viewModel.navigate(.show(zoom: .day, day: $0)) },
                onPage: { viewModel.navigate(.page(steps: $0)) }
            )
            .padding(.top, 4)
            pager
        }
        .coordinateSpace(.calendarDay)
        .onPreferenceChange(CalendarEventFramesKey.self) { eventFrames = $0 }
        .accessibilityIdentifier(CalendarIdentifiers.screen)
    }
}

// MARK: - Subviews
private extension CalendarDayView {

    static let duration = 0.3
    /// Pages on each side of the anchor; the pager recenters before a swipe can reach the last one.
    static let daysAround = 366

    /// The days as pages that follow the finger: a slow drag past half the width or a short fast flick turns to the
    /// next or the previous day, never further; a shorter drag springs back. A day selected elsewhere scrolls into
    /// view from its side. Nothing turns while an item is held or selected.
    var pager: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(pageDays, id: \.self) { key in
                    page(key)
                        .containerRelativeFrame(.horizontal)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(OnePagePaging())
        .scrollIndicators(.hidden)
        .scrollPosition(id: $visibleDay)
        .scrollDisabled(state.drag != nil || state.selectedItemId != nil)
        .onScrollPhaseChange { _, newPhase in
            phase = newPhase
            if newPhase == .idle { settle() }
        }
        // The page can be reported after the scroll came to rest, so a late report settles too.
        .onChange(of: visibleDay) {
            if phase == .idle { settle() }
        }
        .onAppear {
            anchorDay = state.selectedDay
            visibleDay = state.selectedDay
        }
        .onChange(of: state.selectedDay) {
            requestedDay = nil
            guard visibleDay != state.selectedDay else { return }
            recenterIfNeeded(on: state.selectedDay)
            withAnimation(.easeInOut(duration: Self.duration)) { visibleDay = state.selectedDay }
        }
    }

    var pageDays: [String] {
        let center = anchorDay ?? state.selectedDay
        return (-Self.daysAround...Self.daysAround).map { CalendarDates.shifted(center, by: $0) }
    }

    /// Shows the day the pager settled on.
    func settle() {
        let current = requestedDay ?? state.selectedDay
        guard let visibleDay, visibleDay != current else { return }
        requestedDay = visibleDay
        recenterIfNeeded(on: visibleDay)
        viewModel.navigate(.page(steps: CalendarDates.days(from: current, to: visibleDay)))
    }

    func recenterIfNeeded(on day: String) {
        let center = anchorDay ?? state.selectedDay
        if abs(CalendarDates.days(from: center, to: day)) > Self.daysAround - 14 { anchorDay = day }
    }

    func dayState(_ key: String) -> CalendarDayState {
        state.days.first { $0.date == key } ?? CalendarDayState(date: key)
    }

    /// The date, the row of all-day items and the timeline of one day.
    func page(_ key: String) -> some View {
        ScrollViewReader { scroll in
            VStack(spacing: 0) {
                Text(CalendarDates.dayTitle(key))
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .accessibilityAddTraits(.isHeader)
                Divider()
                CalendarAllDayRow(
                    items: allDayItems(key),
                    selectedItemId: state.selectedItemId,
                    drag: state.drag,
                    handlers: handlers(scroll, day: key)
                )
                Divider()
                timeline(scroll, day: key)
            }
            .background(.background)
        }
    }

    /// The items without a time, and the item that is held over the all-day row.
    func allDayItems(_ key: String) -> [CalendarItem] {
        let day = dayState(key)
        var items = day.items.filter { $0.allDay || $0.startMinutes == nil }
        if let drag = state.drag, drag.allDay, let held = day.items.first(where: { $0.id == drag.itemId }),
            !items.contains(where: { $0.id == held.id }) {
            items.append(held)
        }
        return items
    }

    func timeline(_ scroll: ScrollViewProxy, day key: String) -> some View {
        ScrollView {
            CalendarTimelineView(
                day: dayState(key),
                isToday: key == state.today,
                nowMinutes: state.nowMinutes,
                selectedItemId: state.selectedItemId,
                drag: state.drag,
                handlers: handlers(scroll, day: key),
                onResize: { item, edge, location in
                    viewModel.gesture(.dragResize(itemId: item.id, edge: edge, rawMinutes: minutes(at: location.y)))
                },
                onResizeEnd: { viewModel.gesture(.endDrag(commit: true)) },
                onMenu: menu,
                onDeselect: { viewModel.gesture(.tapBackground) },
                onOpenSleep: { viewModel.open(.sleep(night: $0)) },
                onPaste: state.clipboard == nil ? nil : { location in
                    viewModel.edit(.paste(day: key, rawStart: minutes(at: location.y), allDay: false))
                }
            )
            .onTapGesture { viewModel.gesture(.tapBackground) }
        }
        .reportsFrame(CalendarViewportFrameKey.self)
        // Several pages are laid out at once; only the selected day's page measures the timeline.
        .onPreferenceChange(CalendarContentFrameKey.self) { if key == state.selectedDay { contentFrame = $0 } }
        .onPreferenceChange(CalendarViewportFrameKey.self) { if key == state.selectedDay { viewportFrame = $0 } }
        .onAppear { scrollToStart(scroll, day: key) }
    }
}

// MARK: - Gestures
private extension CalendarDayView {

    func handlers(_ scroll: ScrollViewProxy, day key: String) -> CalendarItemHandlers {
        CalendarItemHandlers(
            tap: { viewModel.gesture(.tap(itemId: $0.id)) },
            select: { viewModel.gesture(.select(itemId: $0.id)) },
            move: { item, location, start in
                viewModel.gesture(.dragMove(
                    itemId: item.id,
                    day: key,
                    rawStart: rawStart(item, location: location, start: start),
                    overAllDayRow: location.y < viewportFrame.minY,
                    overEventId: item.isTask ? eventId(at: location, excluding: item.id) : nil
                ))
                autoScroll(scroll, finger: location)
            },
            end: { _, moved in viewModel.gesture(.endDrag(commit: moved)) },
            toggle: { viewModel.gesture(.toggleDone(itemId: $0)) },
            openTask: { viewModel.gesture(.tap(itemId: $0)) }
        )
    }

    func menu(_ action: CalendarEditAction, _ item: CalendarItem) {
        switch action {
        case .cut: viewModel.edit(.cut(itemId: item.id))
        case .copy: viewModel.edit(.copy(itemId: item.id))
        case .duplicate: viewModel.edit(.duplicate(itemId: item.id))
        case .delete: viewModel.edit(.requestDelete(itemId: item.id))
        }
    }

    /// The minutes of the day at a vertical place of the day view; not snapped, the shared layer does that.
    func minutes(at position: CGFloat) -> Int {
        Int(((position - contentFrame.minY) / CalendarGeometry.hourHeight * 60).rounded())
    }

    /// Where the top of the held item is: the finger's place less the distance it grabbed the item below its top.
    func rawStart(_ item: CalendarItem, location: CGPoint, start: CGPoint) -> Int {
        let grabbed = item.startMinutes.map { minutes(at: start.y) - $0 } ?? 15
        return minutes(at: location.y) - grabbed
    }

    func eventId(at location: CGPoint, excluding id: String) -> String? {
        eventFrames.first { $0.key != id && $0.value.contains(location) }?.key
    }

    func scrollToStart(_ scroll: ScrollViewProxy, day key: String) {
        let hour = key == state.today ? max(state.nowMinutes / 60 - 2, 0) : 7
        // The timeline is not laid out yet when the day appears, so the scroll waits for the next turn.
        Task { @MainActor in
            scroll.scrollTo(CalendarGeometry.hourId(hour), anchor: .top)
        }
    }

    /// Scrolls the timeline an hour when the finger holding an item is near its top or bottom edge.
    func autoScroll(_ scroll: ScrollViewProxy, finger: CGPoint) {
        let edge: CGFloat = 48
        guard Date().timeIntervalSince(lastAutoScroll) > 0.3, viewportFrame != .zero else { return }
        let top = Int(((viewportFrame.minY - contentFrame.minY) / CalendarGeometry.hourHeight).rounded(.down))
        let target: Int
        if finger.y > viewportFrame.minY, finger.y < viewportFrame.minY + edge {
            target = max(top - 1, 0)
        } else if finger.y > viewportFrame.maxY - edge {
            target = min(top + 1, 23)
        } else {
            return
        }
        lastAutoScroll = Date()
        withAnimation(.linear(duration: 0.25)) { scroll.scrollTo(CalendarGeometry.hourId(target), anchor: .top) }
    }
}
