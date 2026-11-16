import CoreKit
import SwiftUI

/// The row above the timeline for what has no time: holidays, birthdays, events of the whole day and tasks without a
/// time. Each can be held and pulled into the timeline to give it a time.
struct CalendarAllDayRow: View {

    // MARK: - Dependencies
    let items: [CalendarItem]
    let selectedItemId: String?
    let drag: CalendarDrag?
    let handlers: CalendarItemHandlers

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Text("calendar.allDay", bundle: .module)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: CalendarGeometry.gutter, alignment: .trailing)
                .padding(.trailing, 8)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items, id: \.identity) { item in
                    chip(item)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 8)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarIdentifiers.allDayRow)
    }
}

// MARK: - Subviews
private extension CalendarAllDayRow {

    @ViewBuilder
    func chip(_ item: CalendarItem) -> some View {
        let dragged = drag?.itemId == item.id
        HStack(spacing: 6) {
            if item.isTask {
                CalendarTaskCheckbox(
                    done: item.done,
                    tint: item.tint,
                    size: 16,
                    enabled: item.canToggle,
                    label: item.toggleLabel
                ) { handlers.toggle(item.id) }
            } else if item.kind == .birthday {
                Image(systemName: "gift").font(.caption).foregroundStyle(item.tint)
            }
            Text(item.title)
                .font(.caption.weight(.semibold))
                .strikethrough(item.done)
                .foregroundStyle(item.done ? .secondary : .primary)
                .lineLimit(1)
            if item.isTask {
                Text("calendar.item.task", bundle: .module).font(.caption2).foregroundStyle(.secondary)
            }
            if let note = item.traceDescription ?? item.carriedDescription {
                Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(item.tint.opacity(item.isTask ? 0.08 : 0.18), in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            if item.isGhost {
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            } else if selectedItemId == item.id {
                RoundedRectangle(cornerRadius: 6).strokeBorder(item.tint, lineWidth: 2)
            }
        }
        .opacity(dragged ? 0.4 : 1)
        .calendarItemGestures(
            enabled: item.editable,
            onTap: { handlers.tap(item) },
            onSelect: { handlers.select(item) },
            onMove: { handlers.move(item, $0, $1) },
            onEnd: { handlers.end(item, $0) }
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(CalendarIdentifiers.item(item.id))
    }
}
