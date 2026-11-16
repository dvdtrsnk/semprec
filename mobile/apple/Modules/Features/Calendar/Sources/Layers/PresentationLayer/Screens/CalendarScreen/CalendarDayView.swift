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

    // MARK: - Body
    var body: some View {
        ScrollViewReader { scroll in
            VStack(spacing: 0) {
                CalendarWeekStrip(
                    selectedDay: state.selectedDay,
                    today: state.today,
                    onPick: { viewModel.navigate(.show(zoom: .day, day: $0)) },
                    onPage: { viewModel.navigate(.page(steps: $0)) }
                )
                .padding(.top, 4)
                Text(CalendarDates.dayTitle(state.selectedDay))
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .accessibilityAddTraits(.isHeader)
                Divider()
                CalendarAllDayRow(
                    items: allDayItems,
                    selectedItemId: state.selectedItemId,
                    drag: state.drag,
                    handlers: handlers(scroll)
                )
                Divider()
                timeline(scroll)
            }
            .coordinateSpace(.calendarDay)
            .onPreferenceChange(CalendarEventFramesKey.self) { eventFrames = $0 }
        }
        .accessibilityIdentifier(CalendarIdentifiers.screen)
    }
}

// MARK: - Subviews
private extension CalendarDayView {

    var day: CalendarDayState {
        state.days.first { $0.date == state.selectedDay } ?? CalendarDayState(date: state.selectedDay)
    }

    /// The items without a time, and the item that is held over the all-day row.
    var allDayItems: [CalendarItem] {
        var items = day.items.filter { $0.allDay || $0.startMinutes == nil }
        if let drag = state.drag, drag.allDay, let held = day.items.first(where: { $0.id == drag.itemId }),
            !items.contains(where: { $0.id == held.id }) {
            items.append(held)
        }
        return items
    }

    func timeline(_ scroll: ScrollViewProxy) -> some View {
        ScrollView {
            CalendarTimelineView(
                day: day,
                isToday: state.selectedDay == state.today,
                nowMinutes: state.nowMinutes,
                selectedItemId: state.selectedItemId,
                drag: state.drag,
                handlers: handlers(scroll),
                onResize: { item, edge, location in
                    viewModel.gesture(.dragResize(itemId: item.id, edge: edge, rawMinutes: minutes(at: location.y)))
                },
                onResizeEnd: { viewModel.gesture(.endDrag(commit: true)) },
                onMenu: menu,
                onDeselect: { viewModel.gesture(.tapBackground) },
                onOpenSleep: { viewModel.open(.sleep(night: $0)) },
                onPaste: state.clipboard == nil ? nil : { location in
                    viewModel.edit(.paste(day: state.selectedDay, rawStart: minutes(at: location.y), allDay: false))
                }
            )
            .onTapGesture { viewModel.gesture(.tapBackground) }
        }
        .reportsFrame(CalendarViewportFrameKey.self)
        .onPreferenceChange(CalendarContentFrameKey.self) { contentFrame = $0 }
        .onPreferenceChange(CalendarViewportFrameKey.self) { viewportFrame = $0 }
        .simultaneousGesture(swipe)
        .onAppear { scrollToStart(scroll) }
        .onChange(of: state.selectedDay) { scrollToStart(scroll) }
    }

    /// A swipe sideways shows the next or the previous day; it is left alone while something is held.
    var swipe: some Gesture {
        DragGesture(minimumDistance: 30).onEnded { value in
            let sideways = abs(value.translation.width) > abs(value.translation.height) * 2
            guard sideways, state.drag == nil, state.selectedItemId == nil else { return }
            viewModel.navigate(.page(steps: value.translation.width < 0 ? 1 : -1))
        }
    }
}

// MARK: - Gestures
private extension CalendarDayView {

    func handlers(_ scroll: ScrollViewProxy) -> CalendarItemHandlers {
        CalendarItemHandlers(
            tap: { viewModel.gesture(.tap(itemId: $0.id)) },
            select: { viewModel.gesture(.select(itemId: $0.id)) },
            move: { item, location, start in
                viewModel.gesture(.dragMove(
                    itemId: item.id,
                    day: state.selectedDay,
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

    func scrollToStart(_ scroll: ScrollViewProxy) {
        let hour = state.selectedDay == state.today ? max(state.nowMinutes / 60 - 2, 0) : 7
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
