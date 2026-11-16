import CoreKit
import SwiftUI

/// An event or a task with a time, drawn as a block of the day timeline: a bar and a tinted body with the title, the
/// place and time, and the tasks that sit inside an event.
struct CalendarTimedItemView: View {

    // MARK: - Dependencies
    let item: CalendarItem
    let selected: Bool
    let dropTarget: Bool
    let dragging: Bool
    /// Where the block is drawn, in minutes of the day; it differs from the item's own while it is dragged.
    let range: (start: Int, end: Int)
    let onToggle: (String) -> Void
    let onOpenTask: (String) -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if item.isTask {
                CalendarTaskCheckbox(
                    done: item.done,
                    tint: item.tint,
                    size: 18,
                    enabled: item.canToggle,
                    label: item.toggleLabel
                ) { onToggle(item.id) }
                .padding(.leading, 8)
                .padding(.top, 4)
            } else {
                Rectangle().fill(item.tint).frame(width: 4)
            }
            VStack(alignment: .leading, spacing: 2) {
                header
                if let time = timeText {
                    Text(time).font(.caption2).foregroundStyle(.secondary)
                }
                if let place = item.place {
                    Text(place).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                if let carried = item.carriedDescription {
                    Text(carried).font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(item.tasks) { task in
                    taskRow(task)
                }
                Spacer(minLength: 0)
                if dropTarget {
                    Text("calendar.dropInto", bundle: .module)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(item.tint)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(item.tint.opacity(item.isTask ? 0.08 : 0.16))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay { outline }
        .opacity(dragging ? 0.85 : 1)
        .shadow(color: .black.opacity(dragging ? 0.25 : 0), radius: dragging ? 8 : 0, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier(CalendarIdentifiers.item(item.id))
    }
}

// MARK: - Subviews
private extension CalendarTimedItemView {

    var header: some View {
        HStack(spacing: 4) {
            Text(item.title)
                .font(.caption.weight(.semibold))
                .strikethrough(item.done)
                .foregroundStyle(item.done ? .secondary : .primary)
                .lineLimit(2)
            if !item.tasks.isEmpty {
                Text("\(item.tasks.filter(\.isDone).count)/\(item.tasks.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if item.tentative {
                Image(systemName: "questionmark.circle").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    func taskRow(_ task: CalendarEventTask) -> some View {
        HStack(spacing: 4) {
            CalendarTaskCheckbox(
                done: task.isDone,
                tint: item.tint,
                size: 12,
                enabled: true,
                label: task.toggleLabel
            ) { onToggle(task.id) }
            Text(task.title)
                .font(.caption2)
                .strikethrough(task.isDone)
                .foregroundStyle(task.isDone ? .secondary : .primary)
                .lineLimit(1)
            if let note = task.stateNote {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(task.state == .missed ? Color.orange : .secondary)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onOpenTask(task.id) }
    }

    @ViewBuilder var outline: some View {
        let shape = RoundedRectangle(cornerRadius: 6)
        if item.isGhost {
            shape.strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        } else if selected || dropTarget {
            shape.strokeBorder(item.tint, lineWidth: 2)
        }
    }

    var timeText: String? {
        guard item.startMinutes != nil else { return nil }
        return item.hasEnd || dragging ? CalendarDates.range(from: range.start, to: range.end)
            : CalendarDates.clock(minutes: range.start)
    }

    var accessibilityText: String {
        [item.title, timeText, item.place].compactMap { $0 }.joined(separator: ", ")
    }
}
