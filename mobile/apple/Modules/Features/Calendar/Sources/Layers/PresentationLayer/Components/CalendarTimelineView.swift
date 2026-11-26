import CoreKit
import DesignSystem
import SwiftUI

/// One day hour by hour: the hour lines, the sleep bands, the timed items next to the ones they overlap, the
/// handles of the selected item and, on today, the line of the present time.
struct CalendarTimelineView: View {

    // MARK: - Dependencies
    let day: CalendarDayState
    let geometry: CalendarGeometry
    let isToday: Bool
    let nowMinutes: Int
    let selectedItemId: String?
    let drag: CalendarDrag?
    /// Where the finger would put the held block, in minutes of the day and not snapped: the block follows it smoothly.
    let dragFollower: CalendarDragFollower
    /// The item a finger holds, wherever it started: it is drawn here too when the day was turned to under it.
    let heldItem: CalendarItem?
    let handlers: CalendarItemHandlers
    /// The finger has travelled `travel` points since it touched the handle.
    let onResize: (_ item: CalendarItem, _ edge: CalendarEdge, _ travel: CGFloat) -> Void
    let onResizeEnd: () -> Void
    /// The night held on this day, its moves, and the times a finger is moving one to.
    let selectedNight: String?
    let sleepDrag: CalendarSleepDrag?
    let sleepHandlers: CalendarSleepHandlers
    let onPaste: ((CGPoint) -> Void)?
    /// A tap on the day where there is no item.
    let onTapBackground: () -> Void

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width - CalendarGeometry.gutter - 8, 0)
            ZStack(alignment: .topLeading) {
                hours(width: width)
                    .contentShape(Rectangle())
                    .onTapGesture { onTapBackground() }
                    .gesture(pasteGesture)
                sleepBands(width: width)
                ForEach(timedItems, id: \.identity) { item in
                    block(item, width: width)
                }
                ghost(width: width)
                snapLabel
                if let carried = carriedItem {
                    block(carried, width: width, interactive: false)
                }
                if isToday {
                    nowLine(width: width)
                }
            }
            .frame(width: proxy.size.width, height: geometry.height, alignment: .topLeading)
            .animation(.snappy(duration: 0.28), value: timedItems.map(\.identity))
            .contentShape(Rectangle())
        }
        .frame(height: geometry.height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.timeline)
    }
}

// MARK: - Items
extension CalendarTimelineView {

    /// How far each step of a cascade is drawn in from the left edge of its column, as the system Calendar does.
    static let cascadeStep: CGFloat = 11
}

private extension CalendarTimelineView {

    /// The timed items. The one that is being dragged stays among them, drawn at the place the drag would put it: the
    /// view that owns the finger's gesture must not leave the screen while the finger is down, or the gesture is
    /// cancelled and the drop never happens.
    var timedItems: [CalendarItem] {
        day.items.filter { $0.startMinutes != nil && !$0.allDay }
    }

    /// The held item where the drag would put it on this day's timeline, when none of the day's own blocks is it: an
    /// item carried in from another day, or one without a time taken out of the all-day row, which the timeline then
    /// shows as a block, as the all-day row shows a block taken into it as a chip.
    var carriedItem: CalendarItem? {
        guard let drag, let heldItem, drag.date == day.date, !drag.allDay, drag.intoEventId == nil,
            !timedItems.contains(where: { $0.id == heldItem.id }) else { return nil }
        return heldItem.alone(on: day.date)
    }

    func place(_ item: CalendarItem) -> (start: Int, end: Int) {
        if let drag, drag.itemId == item.id, let start = drag.startMinutes, let end = drag.endMinutes {
            return (start, end)
        }
        return (item.startMinutes ?? 0, item.endMinutes ?? 0)
    }

    @ViewBuilder
    func block(_ item: CalendarItem, width: CGFloat, interactive: Bool = true) -> some View {
        let range = place(item)
        let columns = max(item.columns, 1)
        let columnWidth = width / CGFloat(columns)
        let stepIn = CGFloat(item.depth) * Self.cascadeStep
        let height = geometry.blockHeight(start: range.start, end: range.end)
        let selected = selectedItemId == item.id
        let dragging = drag?.itemId == item.id
        let target = drag?.intoEventId == item.id
        let raised = dragging || selected
        // Held over the all-day row the block gives way to the chip there, held over an event it is on its way into
        // it; either way it stays in place so that the finger's gesture goes on.
        let away = interactive && dragging
            && (drag?.allDay == true || drag?.intoEventId != nil || drag?.date != day.date)
        // A held block comes out over its neighbours at the full width of the day, as in the system Calendar.
        let blockWidth = selected ? width : columnWidth - stepIn
        let blockX = selected ? 0 : CGFloat(item.column) * columnWidth + stepIn
        let follows = dragging && !away
        CalendarTimedItemView(
            item: item,
            selected: selected,
            dropTarget: target,
            dragging: dragging,
            range: range,
            height: height,
            onToggle: handlers.toggle,
            onOpenTask: handlers.openTask
        )
        .frame(width: max(blockWidth - 2, 0), height: height)
        .calendarItemGestures(item, enabled: item.editable, selected: selected, handlers: handlers)
        .overlay { if interactive { handles(item, height: height, selected: selected) } }
        // The picture of an item carried in from another day takes no touches.
        .allowsHitTesting(interactive)
        .background(CalendarItemFrameReporter(id: item.id, isEvent: item.kind == .event))
        .background(selected ? AnyView(SelectedFrameReporter()) : AnyView(EmptyView()))
        // Placed by padding rather than by an offset: the system's drag finds the item where its layout puts it.
        .padding(.leading, CalendarGeometry.gutter + blockX)
        .padding(.top, geometry.y(minutes: range.start))
        // The held block follows the finger between the quarter hours the shared layer snaps it to.
        .modifier(CalendarFollowedBlock(
            follower: follows ? dragFollower : nil,
            start: range.start,
            geometry: geometry
        ))
        .animation(.snappy(duration: 0.2), value: dragging)
        .opacity(away ? (drag?.allDay == true ? 0 : 0.3) : 1)
        .animation(.snappy(duration: 0.24), value: selected)
        .animation(.snappy(duration: 0.18), value: away)
        // A block that appears or goes away does so as the system Calendar's does, and the ones around it make room.
        .transition(.opacity.combined(with: .scale(scale: 0.92)))
        // A block that starts later than the one it overlaps lies over it; a held block lies over everything.
        .zIndex(raised ? 100 : Double(1 + item.depth))
    }

    /// Where the held item came from, faint, while it is carried about the day.
    @ViewBuilder
    func ghost(width: CGFloat) -> some View {
        if let drag, drag.date == day.date, !drag.allDay, drag.intoEventId == nil,
            let item = day.items.first(where: { $0.id == drag.itemId }),
            let start = item.startMinutes, let end = item.endMinutes {
            let height = geometry.blockHeight(start: start, end: end)
            RoundedRectangle(cornerRadius: 6)
                .fill(item.tint.opacity(0.25))
                .frame(width: max(width / CGFloat(max(item.columns, 1)) - 2, 0), height: height)
                .offset(x: CalendarGeometry.gutter + CGFloat(item.column) * width / CGFloat(max(item.columns, 1)),
                        y: geometry.y(minutes: start))
                .allowsHitTesting(false)
        }
    }

    /// The quarter hour the held block will snap to, in the gutter at its place, as the system Calendar shows it.
    @ViewBuilder var snapLabel: some View {
        if let drag, drag.date == day.date, !drag.allDay, drag.intoEventId == nil, let start = drag.startMinutes,
            start % 60 != 0 {
            Text(CalendarDates.clock(minutes: start))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: CalendarGeometry.gutter - 6, alignment: .trailing)
                .offset(y: geometry.y(minutes: start) - 7)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    func handles(_ item: CalendarItem, height: CGFloat, selected: Bool) -> some View {
        if selected, item.editable, !item.isGhost, !item.allDay {
            ZStack {
                handle(item, edge: .start).frame(maxHeight: .infinity, alignment: .top).offset(y: -8)
                handle(item, edge: .end).frame(maxHeight: .infinity, alignment: .bottom).offset(y: 8)
            }
        }
    }

    func handle(_ item: CalendarItem, edge: CalendarEdge) -> some View {
        Circle()
            .fill(Color(white: 1))
            .overlay(Circle().strokeBorder(item.tint, lineWidth: 2))
            .frame(width: 12, height: 12)
            .padding(10)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .calendarDay)
                    .onChanged { onResize(item, edge, $0.location.y - $0.startLocation.y) }
                    .onEnded { _ in onResizeEnd() }
            )
            .frame(maxWidth: .infinity, alignment: edge == .start ? .trailing : .leading)
            .padding(.horizontal, 12)
            .accessibilityLabel(
                Text(edge == .start ? "calendar.handle.start" : "calendar.handle.end", bundle: .module)
            )
    }

    var pasteGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.5)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .calendarDay))
            .onEnded { value in
                if case .second(true, let drag?) = value { onPaste?(drag.location) }
            }
    }
}

// MARK: - Grid
private extension CalendarTimelineView {

    /// The hour lines as real rows, so that scrolling to an hour finds its place in the layout.
    func hours(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 6) {
                    Text(CalendarDates.hourLabel(hour))
                        .font(.caption2)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(.secondary)
                        .frame(width: CalendarGeometry.gutter - 6, alignment: .trailing)
                        .offset(y: -7)
                        .opacity(isCoveredByNow(hour) ? 0 : 1)
                    Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 0.5)
                }
                .frame(height: geometry.hourHeight, alignment: .top)
                .id(CalendarGeometry.hourId(hour, day: day.date))
            }
        }
    }

    /// Whether the current time's capsule sits over this hour's label, which then gives way to it.
    func isCoveredByNow(_ hour: Int) -> Bool {
        isToday && abs(hour * 60 - nowMinutes) < 20
    }

    /// The current time in a capsule over the hour labels, and the line from it across the day, in the gold that marks
    /// today wherever the app shows dates.
    func nowLine(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Text(CalendarDates.clock(minutes: nowMinutes))
                .font(.caption2.weight(.bold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Capsule().fill(Theme.Colors.today))
                .frame(width: CalendarGeometry.gutter, alignment: .trailing)
            Rectangle().fill(Theme.Colors.today).frame(height: 1)
        }
        .frame(height: 18)
        .offset(y: geometry.y(minutes: nowMinutes) - 9)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Sleep
private extension CalendarTimelineView {

    /// The bands and the bedtime reminders of the sleep on this day, as the shared layer cut them; a night a finger
    /// moves is drawn at the times it is moving to.
    @ViewBuilder
    func sleepBands(width: CGFloat) -> some View {
        ForEach(Array(day.sleepParts(dragging: sleepDrag).enumerated()), id: \.offset) { _, part in
            switch part {
            case .band(let sleep, let band, let isEvening):
                sleepBand(sleep, band: band, evening: isEvening, width: width)
            case .reminder(let sleep, let minutes):
                prepMarker(sleep, minutes: minutes, width: width)
            }
        }
    }

    /// An evening band is labelled with its bedtime at the top, a morning band with its wake time at the bottom.
    func sleepBand(_ sleep: CalendarSleep, band: Range<Int>, evening: Bool, width: CGFloat) -> some View {
        let labelTop = evening
            ? geometry.y(minutes: band.lowerBound)
            : geometry.y(minutes: band.upperBound) - Self.labelHeight
        return CalendarSleepBand(
            sleep: sleep,
            evening: evening,
            startMinutes: band.lowerBound,
            endMinutes: band.upperBound,
            geometry: geometry,
            width: width,
            selected: selectedNight == sleep.night || sleepDrag?.night == sleep.night,
            labelHidden: isLabelCovered(top: labelTop, width: width),
            handlers: sleepHandlers
        )
    }

    func prepMarker(_ sleep: CalendarSleep, minutes: Int, width: CGFloat) -> some View {
        Button { sleepHandlers.open(sleep.night) } label: {
            HStack(spacing: 4) {
                Image(systemName: "bell").font(.caption2)
                Text(
                    String(
                        format: String(localized: "calendar.sleep.prep", bundle: .module),
                        CalendarDates.clock(minutes: minutes)
                    )
                )
                .font(.caption2)
            }
            .foregroundStyle(sleepTint)
            .opacity(isLabelCovered(top: geometry.y(minutes: minutes) - 9, width: width) ? 0 : 1)
            .padding(.horizontal, 6)
            .frame(width: width, height: 18, alignment: .leading)
        }
        .buttonStyle(.plain)
        .offset(x: CalendarGeometry.gutter, y: geometry.y(minutes: minutes) - 9)
    }

    /// Whether a block of an item lies where a label at the leading edge of the sleep band would be written, so the
    /// label gives way to it rather than being drawn over its words.
    func isLabelCovered(top: CGFloat, width: CGFloat) -> Bool {
        let labelWidth: CGFloat = 190
        return timedItems.contains { item in
            let range = place(item)
            let columnWidth = width / CGFloat(max(item.columns, 1))
            let left = CGFloat(item.column) * columnWidth + CGFloat(item.depth) * Self.cascadeStep
            let blockTop = geometry.y(minutes: range.start)
            let blockBottom = blockTop + geometry.blockHeight(start: range.start, end: range.end)
            return left < labelWidth && blockTop < top + Self.labelHeight && blockBottom > top
        }
    }

    /// How tall the label of a sleep band is.
    static var labelHeight: CGFloat { 18 }

    var sleepTint: Color { Theme.Colors.sleep }
}
