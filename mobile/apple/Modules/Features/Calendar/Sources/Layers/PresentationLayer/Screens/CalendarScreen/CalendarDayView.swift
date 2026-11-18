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
    /// The height of an hour the person pinched the timeline to, kept for the next time.
    @AppStorage("calendarHourHeight")
    private var hourHeight = Double(CalendarGeometry.standardHourHeight)
    /// Counts the day changes that tick: a turn of the day pager, a tap on a day, or a day selected elsewhere.
    @State private var dayTicks = 0
    /// The day this view already ticked for, whose arrival from the shared state then ticks no more.
    @State private var tickedDay: String?
    /// Set while the week strip turns to another week, whose new day comes without a haptic.
    @State private var isTurningWeek = false
    /// Where the fingers of a zoom are, in global coordinates, while one is under way.
    @State private var pinchY: CGFloat?
    /// The day a turn or a tap just chose, shown at once until the shared state arrives at it.
    @State private var chosenDay: String?

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            CalendarWeekStrip(
                selectedDay: shownDay,
                today: state.today,
                onPick: { day in
                    tick(for: day)
                    chosenDay = day
                    viewModel.navigate(.show(zoom: .day, day: day))
                },
                onPage: { steps in
                    isTurningWeek = true
                    chosenDay = CalendarDates.shifted(shownDay, by: steps)
                    viewModel.navigate(.page(steps: steps))
                }
            )
            .padding(.top, 4)
            CalendarPager(
                current: shownDay,
                neighbour: { CalendarDates.shifted($0, by: $1) },
                isEnabled: state.drag == nil && state.selectedItemId == nil,
                onTurn: { steps in
                    let day = CalendarDates.shifted(shownDay, by: steps)
                    tick(for: day)
                    chosenDay = day
                    viewModel.navigate(.page(steps: steps))
                },
                page: page
            )
            .modifier(CalendarVerticalPinch(hourHeight: $hourHeight, pinchY: $pinchY))
        }
        .sensoryFeedback(.impact(weight: .light), trigger: dayTicks)
        .onChange(of: state.selectedDay) { _, new in
            if new == chosenDay { chosenDay = nil }
            defer { isTurningWeek = false }
            if new == tickedDay || isTurningWeek { return }
            tick(for: new)
        }
        .coordinateSpace(.calendarDay)
        .onPreferenceChange(CalendarEventFramesKey.self) { eventFrames = $0 }
        .accessibilityIdentifier(CalendarIdentifiers.screen)
    }
}

// MARK: - Subviews
private extension CalendarDayView {

    /// The selected day as this view shows it: the one just chosen, ahead of the shared state.
    var shownDay: String { chosenDay ?? state.selectedDay }

    /// Plays the light haptic of a new day the moment the change is decided.
    func tick(for day: String) {
        tickedDay = day
        dayTicks += 1
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
                    .frame(maxWidth: .infinity)
                    .overlay(alignment: .trailing) { weekNumber(key) }
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

    /// The week the day is in, quietly at the end of the date line.
    func weekNumber(_ key: String) -> some View {
        let format = String(localized: "calendar.weekNumber", bundle: .module)
        return Text(String(format: format, locale: .current, CalendarDates.isoWeek(key)))
            .font(.subheadline)
            .foregroundStyle(.secondary)
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
        CalendarZoomableTimeline(
            hourHeight: hourHeight,
            pinchY: pinchY,
            startMinutes: startHour(day: key) * 60
        ) { geometry in
            CalendarTimelineView(
                day: dayState(key),
                geometry: geometry,
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
        Int(((position - contentFrame.minY) / CGFloat(hourHeight) * 60).rounded())
    }

    /// Where the top of the held item is: the finger's place less the distance it grabbed the item below its top.
    func rawStart(_ item: CalendarItem, location: CGPoint, start: CGPoint) -> Int {
        let grabbed = item.startMinutes.map { minutes(at: start.y) - $0 } ?? 15
        return minutes(at: location.y) - grabbed
    }

    func eventId(at location: CGPoint, excluding id: String) -> String? {
        eventFrames.first { $0.key != id && $0.value.contains(location) }?.key
    }

    /// The hour a day opens at: two hours before now on today, seven in the morning otherwise.
    func startHour(day key: String) -> Int {
        key == state.today ? max(state.nowMinutes / 60 - 2, 0) : 7
    }

    /// Scrolls the timeline an hour when the finger holding an item is near its top or bottom edge.
    func autoScroll(_ scroll: ScrollViewProxy, finger: CGPoint) {
        let edge: CGFloat = 48
        guard Date().timeIntervalSince(lastAutoScroll) > 0.3, viewportFrame != .zero else { return }
        let top = Int(((viewportFrame.minY - contentFrame.minY) / CGFloat(hourHeight)).rounded(.down))
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
