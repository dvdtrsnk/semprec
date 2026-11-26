import CoreKit
import SwiftUI

/// The area above the timeline for what has no time: holidays, birthdays, events of the whole day and tasks without a
/// time. It is not there on a day with none. The chips stand in two columns, or one when there is a single chip, and
/// the area stops growing at two rows and a half, scrolling inside itself, so a day with many never pushes the
/// timeline off the screen. Each chip can be held and dragged into the timeline to give it a time.
struct CalendarAllDayRow: View {

    // MARK: - Dependencies
    let items: [CalendarItem]
    let selectedItemId: String?
    let drag: CalendarDrag?
    let handlers: CalendarItemHandlers

    // MARK: - State
    /// The height of all the chips, from which the area takes its own.
    @State private var contentHeight: CGFloat = 27

    // MARK: - Constants
    /// The tallest the area gets: two rows of chips and half of the third, which shows there is more to scroll to.
    static let maximumHeight: CGFloat = 70

    // MARK: - Body
    var body: some View {
        if !items.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                Text("calendar.allDay", bundle: .module)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: CalendarGeometry.gutter, alignment: .trailing)
                    .padding(.trailing, 8)
                    .padding(.top, 5)
                chips
                    .padding(.trailing, 8)
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarIdentifiers.allDayRow)
        }
    }
}

// MARK: - Subviews
private extension CalendarAllDayRow {

    /// Whether a chip says where its item came from, which needs the width of the whole area.
    func hasNote(_ item: CalendarItem) -> Bool {
        item.trace != nil || item.hostEventTitle != nil || item.carriedFrom != nil
    }

    var columns: [GridItem] {
        let wide = items.count > 1 && !items.contains(where: hasNote)
        return Array(repeating: GridItem(.flexible(), spacing: 4), count: wide ? 2 : 1)
    }

    /// Two chips to a row, scrolling when there are more rows than the area shows.
    var chips: some View {
        ScrollView {
            grid.onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { contentHeight = $0 })
        }
        .scrollIndicators(.hidden)
        .scrollDisabled(contentHeight <= Self.maximumHeight)
        .frame(height: min(contentHeight, Self.maximumHeight))
    }

    var grid: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 4) {
            ForEach(items, id: \.identity) { item in
                chip(item)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
        .animation(.snappy(duration: 0.28), value: items.map(\.identity))
    }

    /// The note of a task that was in an event and was not done is orange, as a warning; other notes are quiet.
    func noteStyle(_ item: CalendarItem) -> AnyShapeStyle {
        item.hostEventTitle == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.orange)
    }

    /// A held chip is the colour of its calendar all through, with white words, as a held block of the timeline.
    func titleStyle(_ item: CalendarItem, held: Bool) -> AnyShapeStyle {
        if held { return AnyShapeStyle(Color.white) }
        return item.done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    /// What a chip says: its checkbox or icon, its title and what notes it carries.
    func chipContent(_ item: CalendarItem, held: Bool) -> some View {
        HStack(spacing: 6) {
            if item.isTask {
                CalendarTaskCheckbox(
                    done: item.done,
                    tint: item.tint,
                    size: 16,
                    enabled: item.canToggle,
                    label: item.toggleLabel
                ) { handlers.toggle(item.id, nil) }
            } else if item.kind == .birthday {
                Image(systemName: "gift").font(.caption).foregroundStyle(item.tint)
            }
            Text(item.displayTitle)
                .font(.caption.weight(.semibold))
                .strikethrough(item.done)
                .foregroundStyle(titleStyle(item, held: held))
                .lineLimit(1)
            if item.isTask {
                Text("calendar.item.task", bundle: .module).font(.caption2).foregroundStyle(.secondary)
            }
            if let note = item.traceDescription ?? item.hostedDescription ?? item.carriedDescription {
                Spacer(minLength: 4)
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(noteStyle(item))
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
    }

    @ViewBuilder
    func chip(_ item: CalendarItem) -> some View {
        let dragged = drag?.itemId == item.id
        let held = selectedItemId == item.id && drag == nil
        chipContent(item, held: held)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            held ? item.tint : item.tint.opacity(item.isTask ? 0.08 : 0.18),
            in: RoundedRectangle(cornerRadius: 6)
        )
        .background(held ? AnyView(SelectedFrameReporter()) : AnyView(EmptyView()))
        .background(CalendarItemFrameReporter(id: item.id, isEvent: false))
        .overlay {
            if item.isGhost {
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        // Carried into the timeline the chip gives way to the block there, as a block carried into this row gives way
        // to its chip.
        .opacity(dragged ? (drag?.allDay == false ? 0 : 0.4) : 1)
        .animation(.snappy(duration: 0.18), value: drag?.allDay)
        .calendarItemGestures(item, enabled: item.editable, selected: selectedItemId == item.id, handlers: handlers)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(CalendarIdentifiers.item(item.id))
        .sempTarget(of: item, meta: String(localized: "calendar.allDay", bundle: .module))
    }
}
