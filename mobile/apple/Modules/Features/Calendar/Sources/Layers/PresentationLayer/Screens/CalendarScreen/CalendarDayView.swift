import CoreKit
import DesignSystem
import SwiftUI

/// One day: the timeline, which scrolls on under a glass header of the week strip, the date and the row of all-day
/// items. Every gesture reports where the finger is; this view turns that into raw minutes of the day and the shared
/// ViewModel decides what they mean.
struct CalendarDayView: View {

    // MARK: - Dependencies
    let state: CalendarState
    let viewModel: CalendarViewModel
    /// Changes with each tap on Today, which overrides a day this view chose ahead of the shared state.
    let todayRequests: Int
    /// The paper behind the calendar, whose haze goes up and down with the shown day's timeline.
    let paper: PaperScroll

    // MARK: - State
    /// Where the shown day's timeline is, read by gestures and followed by the header's backdrop.
    @State var frames = CalendarDayFrames()
    @State var eventFrames: [String: CGRect] = [:]
    /// Where the selected block is, which its menu is placed by.
    @State var selectedFrame: CGRect?
    @State var menuSize = CGSize(width: 280, height: 44)
    /// The item a finger holds and where the finger is and began, kept for the moments the day scrolls under it.
    @State var drag: HeldDrag?
    /// The item a finger holds, from the long press until the finger lifts.
    @State var hold: Hold?
    /// How fast the day scrolls under the held item, in points a second; zero when it does not.
    @State var autoScrollSpeed: CGFloat = 0
    /// Which side edge of the screen a held item is at: -1 the left, 1 the right, 0 neither.
    @State var sideEdge = 0
    /// Counts the moments a held item has rested at a side edge, each of which turns a day.
    @State var edgeMoments = 0
    /// The clock that counts them while the item rests at an edge.
    @State var edgeClock: Task<Void, Never>?
    /// Counts the steps of the day's own scroll, which move the held block under a finger that stays.
    @State var followTicks = 0
    /// The height of an hour the person pinched the timeline to, kept for the next time.
    @AppStorage("calendarHourHeight")
    var hourHeight = Double(CalendarGeometry.standardHourHeight)
    /// Counts the day changes that tick: a turn of the day pager, a tap on a day, or a day selected elsewhere.
    @State var dayTicks = 0
    /// The day this view already ticked for, whose arrival from the shared state then ticks no more.
    @State var tickedDay: String?
    /// Set while the week strip turns to another week, whose new day comes without a haptic.
    @State var isTurningWeek = false
    /// Where the fingers of a zoom are, in global coordinates, while one is under way.
    @State var pinchY: CGFloat?
    /// The day a turn or a tap just chose, shown at once until the shared state arrives at it.
    @State var chosenDay: String?
    /// The height of the glass header, which the timeline starts below and scrolls on under.
    @State var headerHeight: CGFloat = 0
    /// How far the day view sits below the top of the screen, under the status and navigation bars, and how tall it
    /// is: the paper the header shows is a screen tall, as the page's.
    @State var topBarsHeight: CGFloat = 0
    @State var dayHeight: CGFloat = 0
    @State var dayWidth: CGFloat = 0

    // MARK: - Body
    var body: some View {
        ZStack(alignment: .top) {
            CalendarPager(
                current: shownDay,
                neighbour: { CalendarDates.shifted($0, by: $1) },
                // A finger that holds an item never turns a page itself; the day turns when the item rests at an edge.
                isEnabled: hold == nil && state.drag == nil && state.selectedItemId == nil,
                onTurn: { steps in
                    let day = CalendarDates.shifted(shownDay, by: steps)
                    tick(for: day)
                    chosenDay = day
                    viewModel.navigate(.page(steps: steps))
                },
                page: { timeline(day: $0) }
            )
            .modifier(CalendarVerticalPinch(hourHeight: $hourHeight, pinchY: $pinchY))
            headerBackdrop
            header
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { headerHeight = $0 })
            editMenu
        }
        // A new day ticks as moving a selected row to another place does in a note.
        .sensoryFeedback(.selection, trigger: dayTicks)
        .onChange(of: state.selectedDay) { old, new in
            // The chosen day is dropped when the shared state reaches it, or moves somewhere a turn towards it
            // would not pass through.
            if let chosen = chosenDay, new == chosen || !Self.lies(new, between: old, and: chosen) { chosenDay = nil }
            defer { isTurningWeek = false }
            if new == tickedDay || isTurningWeek { return }
            tick(for: new)
        }
        .onChange(of: edgeMoments) {
            guard drag != nil, sideEdge != 0 else { return }
            turnDay(sideEdge)
            sendMove()
        }
        .onChange(of: todayRequests) {
            chosenDay = nil
            // Today plays its own haptic where it is asked for; the day it brings does not tick again.
            if state.selectedDay != state.today { tickedDay = state.today }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { topBarsHeight = $0 })
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { dayHeight = $0 })
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { dayWidth = $0 })
        .coordinateSpace(.calendarDay)
        .onPreferenceChange(CalendarEventFramesKey.self) { eventFrames = $0 }
        .onPreferenceChange(CalendarSelectedFrameKey.self) { selectedFrame = $0 }
        // The held item's movement is read here, on the view that stays while the day turns under the finger.
        .simultaneousGesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .calendarDay)
                .onChanged { follow($0) }
                .onEnded { _ in letGo() }
        )
        .accessibilityIdentifier(CalendarIdentifiers.screen)
    }
}

// MARK: - Subviews
extension CalendarDayView {

    /// The menu of the selected item, a capsule beside it that comes out of it; it is there while the item is held and
    /// not being dragged.
    @ViewBuilder var editMenu: some View {
        ZStack(alignment: .topLeading) {
            if let item = selectedItem, let anchor = selectedFrame, state.drag == nil {
                let origin = CalendarMenuPlacement.origin(
                    menu: menuSize,
                    anchor: anchor,
                    container: CGSize(width: dayWidth, height: dayHeight),
                    top: headerHeight + Self.menuInset,
                    bottom: dayHeight - Self.menuInset
                )
                CalendarEditMenu { menu($0, item) }
                    .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { menuSize = $0 })
                    .offset(x: origin.x, y: origin.y)
                    .transition(.scale(scale: 0.86, anchor: .top).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(.spring(duration: 0.3, bounce: 0.2), value: state.selectedItemId)
        .animation(.spring(duration: 0.3, bounce: 0.2), value: state.drag == nil)
        .zIndex(10)
    }

    /// The item that is selected on the shown day.
    var selectedItem: CalendarItem? {
        guard let id = state.selectedItemId else { return nil }
        return dayState(shownDay).items.first { $0.id == id }
    }

    /// The room the menu keeps from the header and from the bars at the bottom.
    static var menuInset: CGFloat { 4 }

    /// Whether `day` lies strictly between `start` and `end`, in either order.
    static func lies(_ day: String, between start: String, and end: String) -> Bool {
        min(start, end) < day && day < max(start, end)
    }

    /// The selected day as this view shows it: the one just chosen, ahead of the shared state.
    var shownDay: String { chosenDay ?? state.selectedDay }

    /// Plays the light haptic of a new day the moment the change is decided.
    func tick(for day: String) {
        tickedDay = day
        dayTicks += 1
    }

    /// The item a drag is carrying, wherever the window holds it.
    var heldItem: CalendarItem? {
        guard let held = state.drag else { return nil }
        return state.days.lazy.flatMap(\.items).first { $0.id == held.itemId }
    }

    func dayState(_ key: String) -> CalendarDayState {
        state.days.first { $0.date == key } ?? CalendarDayState(date: key)
    }

    /// The week strip, the date and the all-day items of the shown day, over `headerBackdrop`, which reaches up under
    /// the navigation bar. It changes to a new day at once, while the timeline below slides to it.
    var header: some View {
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
            .padding(.bottom, 6)
            headerDivider
            Text(CalendarDates.dayTitle(shownDay))
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) { weekNumber(shownDay) }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .accessibilityAddTraits(.isHeader)
            CalendarAllDayRow(
                items: allDayItems(shownDay),
                selectedItemId: state.selectedItemId,
                drag: state.drag,
                handlers: handlers(day: shownDay)
            )
            // Ends the header: below it is the timeline itself.
            headerDivider
        }
        // The header keeps its shape at the largest text sizes, as the system Calendar's: a week still fits a line.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    /// The colours of the shown day's timeline that lie under the header and the bars above it, blurred until only the
    /// colours remain, made a little more vivid and veiled a little, so the header glows with the items it covers
    /// without showing their shapes, on white in light mode and on black in dark mode. Only the follower inside it
    /// redraws as the day scrolls. It is a picture only and takes no touches.
    var headerBackdrop: some View {
        CalendarTimelineFollower(
            frames: frames,
            base: topBarsHeight,
            content: CalendarTimelineColors(
                day: dayState(shownDay),
                geometry: CalendarGeometry(hourHeight: CGFloat(hourHeight))
            )
        )
        .frame(height: topBarsHeight + headerHeight + Self.backdropBleed, alignment: .top)
        // On the paper the page shows, so the header glows with its haze as with the items it covers.
        .background(alignment: .top) { CalendarPaperHaze(paper: paper, pageHeight: topBarsHeight + dayHeight) }
        .clipped()
        .blur(radius: 24, opaque: true)
        .saturation(1.8)
        .overlay(.background.opacity(0.12))
        .frame(height: topBarsHeight + headerHeight, alignment: .top)
        .clipped()
        // It covers the bars above the day view too, so the glass looks the same from the top of the screen down.
        .offset(y: -topBarsHeight)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// How far below the header the backdrop still takes colour from, so its lower edge does not fade to nothing.
    static var backdropBleed: CGFloat { 48 }

    /// A line of the header, half a point thick (one and a half pixels on a three-times screen), a little stronger
    /// than a system divider so it reads over the coloured backdrop.
    var headerDivider: some View {
        Rectangle()
            .fill(.separator)
            .frame(height: 0.5)
    }

    /// The week the day is in, quietly at the start of the date line.
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

    func timeline(day key: String) -> some View {
        CalendarZoomableTimeline(
            hourHeight: hourHeight,
            pinchY: pinchY,
            startId: CalendarGeometry.hourId(startHour(day: key), day: key),
            topInset: headerHeight,
            // Today brings today's timeline back to the current time.
            startRequests: key == state.today ? todayRequests : 0,
            // Only the shown day's timeline moves the haze; the pages beside it are laid out but not looked at.
            paper: key == shownDay ? paper : nil,
            // Only the shown day scrolls under a held item.
            autoScroll: key == shownDay ? CalendarAutoScroll(
                speed: autoScrollSpeed,
                onStep: {
                    followTicks += 1
                    sendMove()
                },
                isHolding: hold != nil
            ) : .none
        ) { geometry in
            CalendarTimelineView(
                day: dayState(key),
                geometry: geometry,
                isToday: key == state.today,
                nowMinutes: state.nowMinutes,
                selectedItemId: state.selectedItemId,
                drag: state.drag,
                freeStart: freeStart,
                heldItem: heldItem,
                handlers: handlers(day: key),
                onResize: { item, edge, travel in
                    // The edge follows the finger from where it was grabbed, rather than jumping to the finger.
                    let from = (edge == .start ? item.startMinutes : item.endMinutes) ?? 0
                    let moved = Int((travel / CGFloat(hourHeight) * 60).rounded())
                    viewModel.gesture(.dragResize(itemId: item.id, edge: edge, rawMinutes: from + moved))
                },
                onResizeEnd: { viewModel.gesture(.endDrag(commit: true)) },
                onOpenSleep: { viewModel.open(.sleep(night: $0)) },
                onPaste: state.clipboard == nil ? nil : { location in
                    viewModel.edit(.paste(day: key, rawStart: minutes(at: location.y), allDay: false))
                }
            )
            .onTapGesture { viewModel.gesture(.tapBackground) }
            // Several pages are laid out at once; only the selected day's page measures the timeline.
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .calendarDay) }, action: { frame in
                if key == shownDay { frames.update(content: frame) }
            })
        }
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .calendarDay) }, action: { frame in
            if key == shownDay { frames.viewport = frame }
        })
    }
}

/// The paper under the day's header, where the page's haze is: a view of its own, so only it redraws as the haze moves.
private struct CalendarPaperHaze: View {

    let paper: PaperScroll
    let pageHeight: CGFloat

    var body: some View {
        PaperPattern(scrolled: paper.offset, pageHeight: pageHeight)
            .frame(height: pageHeight, alignment: .top)
    }
}
