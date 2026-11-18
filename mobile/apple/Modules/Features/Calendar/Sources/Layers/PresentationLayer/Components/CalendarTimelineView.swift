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
    let handlers: CalendarItemHandlers
    let onResize: (_ item: CalendarItem, _ edge: CalendarEdge, _ location: CGPoint) -> Void
    let onResizeEnd: () -> Void
    let onMenu: (CalendarEditAction, CalendarItem) -> Void
    let onDeselect: () -> Void
    let onOpenSleep: (String) -> Void
    let onPaste: ((CGPoint) -> Void)?

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width - CalendarGeometry.gutter - 8, 0)
            ZStack(alignment: .topLeading) {
                hours(width: width)
                sleepBands(width: width)
                ForEach(timedItems, id: \.identity) { item in
                    block(item, width: width)
                }
                if let preview = previewItem {
                    block(preview, width: width)
                }
                if isToday {
                    nowLine(width: width)
                }
            }
            .frame(width: proxy.size.width, height: geometry.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .gesture(pasteGesture)
            .reportsFrame(CalendarContentFrameKey.self)
        }
        .frame(height: geometry.height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.timeline)
    }
}

// MARK: - Items
private extension CalendarTimelineView {

    /// The timed items, except the one that is being dragged, which is drawn at its previewed place.
    var timedItems: [CalendarItem] {
        day.items.filter { $0.startMinutes != nil && !$0.allDay && $0.id != drag?.itemId }
    }

    /// The item being dragged, shown at the place the drag would put it, when that is a time of this day.
    var previewItem: CalendarItem? {
        guard let drag, !drag.allDay, drag.date == day.date, drag.intoEventId == nil else { return nil }
        return day.items.first { $0.id == drag.itemId }
    }

    func place(_ item: CalendarItem) -> (start: Int, end: Int) {
        if let drag, drag.itemId == item.id, let start = drag.startMinutes, let end = drag.endMinutes {
            return (start, end)
        }
        return (item.startMinutes ?? 0, item.endMinutes ?? 0)
    }

    @ViewBuilder
    func block(_ item: CalendarItem, width: CGFloat) -> some View {
        let range = place(item)
        let columns = max(item.columns, 1)
        let columnWidth = width / CGFloat(columns)
        let height = geometry.blockHeight(start: range.start, end: range.end)
        let selected = selectedItemId == item.id
        let dragging = drag?.itemId == item.id
        let target = drag?.intoEventId == item.id
        let raised = dragging || selected
        CalendarTimedItemView(
            item: item,
            selected: selected,
            dropTarget: target,
            dragging: dragging,
            range: range,
            onToggle: handlers.toggle,
            onOpenTask: handlers.openTask
        )
        .frame(width: max(columnWidth - 2, 0), height: height)
        .calendarItemGestures(
            enabled: item.editable,
            onTap: { handlers.tap(item) },
            onSelect: { handlers.select(item) },
            onMove: { handlers.move(item, $0, $1) },
            onEnd: { handlers.end(item, $0) }
        )
        .calendarItemMenu(
            isPresented: selected && drag == nil,
            onAction: { onMenu($0, item) },
            onDismiss: onDeselect
        )
        .overlay { handles(item, height: height, selected: selected) }
        .background(item.kind == .event ? AnyView(EventFrameReporter(id: item.id)) : AnyView(EmptyView()))
        .offset(
            x: CalendarGeometry.gutter + CGFloat(item.column) * columnWidth,
            y: geometry.y(minutes: range.start)
        )
        .zIndex(raised ? 2 : 1)
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
                    .onChanged { onResize(item, edge, $0.location) }
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

/// Reports the frame of an event block under its id.
private struct EventFrameReporter: View {

    let id: String

    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(key: CalendarEventFramesKey.self, value: [id: proxy.frame(in: .calendarDay)])
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
                    Text(CalendarDates.clock(minutes: hour * 60))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: CalendarGeometry.gutter - 6, alignment: .trailing)
                        .offset(y: -7)
                        .opacity(isCoveredByNow(hour) ? 0 : 1)
                    Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 0.5)
                }
                .frame(height: geometry.hourHeight, alignment: .top)
                .id(CalendarGeometry.hourId(hour))
            }
        }
    }

    /// Whether the current time's capsule sits over this hour's label, which then gives way to it.
    func isCoveredByNow(_ hour: Int) -> Bool {
        isToday && abs(hour * 60 - nowMinutes) < 20
    }

    /// The current time in a red capsule over the hour labels, and the red line from it across the day.
    func nowLine(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Text(CalendarDates.clock(minutes: nowMinutes))
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.red))
                .frame(width: CalendarGeometry.gutter, alignment: .trailing)
            Rectangle().fill(Color.red).frame(height: 1)
        }
        .frame(height: 18)
        .offset(y: geometry.y(minutes: nowMinutes) - 9)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Sleep
private extension CalendarTimelineView {

    @ViewBuilder
    func sleepBands(width: CGFloat) -> some View {
        if let evening = day.sleepEvening {
            sleepBand(evening, from: evening.bedMinutes, to: CalendarGeometry.minutesPerDay, width: width)
            if let prep = evening.prepMinutes {
                prepMarker(evening, minutes: prep, width: width)
            }
        }
        if let morning = day.sleepMorning {
            sleepBand(morning, from: 0, to: morning.wakeMinutes, width: width)
        }
    }

    func sleepBand(_ sleep: CalendarSleep, from start: Int, to end: Int, width: CGFloat) -> some View {
        let evening = start == sleep.bedMinutes
        return Button { onOpenSleep(sleep.night) } label: {
            HStack(spacing: 4) {
                Image(systemName: evening ? "moon.fill" : "alarm").font(.caption2)
                Text(CalendarDates.clock(minutes: evening ? sleep.bedMinutes : sleep.wakeMinutes))
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(sleepTint)
            .padding(6)
            .frame(width: width, height: max(geometry.y(minutes: end) - geometry.y(minutes: start), 0),
                alignment: evening ? .topLeading : .bottomLeading)
            .background(sleepTint.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .offset(x: CalendarGeometry.gutter, y: geometry.y(minutes: start))
        .accessibilityLabel(Text("calendar.sleep.title", bundle: .module))
    }

    func prepMarker(_ sleep: CalendarSleep, minutes: Int, width: CGFloat) -> some View {
        Button { onOpenSleep(sleep.night) } label: {
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
            .padding(.horizontal, 6)
            .frame(width: width, height: 18, alignment: .leading)
        }
        .buttonStyle(.plain)
        .offset(x: CalendarGeometry.gutter, y: geometry.y(minutes: minutes) - 9)
    }

    var sleepTint: Color { Theme.Colors.sleep }
}
