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
    /// How tall the block is, which decides how much of the item it has room to say.
    let height: CGFloat
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
                .padding(.top, Layout.checkboxTop(height))
            } else {
                Rectangle().fill(selected ? Color.clear : item.tint).frame(width: 4)
            }
            VStack(alignment: .leading, spacing: 2) {
                header
                if let time = timeText, Layout.showsTime(height) {
                    Text(time).font(.caption2).foregroundStyle(secondaryStyle).lineLimit(1)
                }
                if let place = item.place, Layout.showsDetails(height) {
                    Text(place).font(.caption2).foregroundStyle(secondaryStyle).lineLimit(1)
                }
                if let carried = item.carriedDescription, Layout.showsDetails(height) {
                    Text(carried).font(.caption2).foregroundStyle(secondaryStyle)
                }
                ForEach(item.tasks.prefix(Layout.taskRows(height))) { task in
                    taskRow(task)
                }
                if dropTarget {
                    Text("calendar.dropInto", bundle: .module)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(item.tint)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, Layout.verticalPadding(height))
            Spacer(minLength: 0)
        }
        // Exactly the height the timeline gives the block, content from the top: a chip too short for its lines
        // cuts them off rather than growing and being centred over its neighbours.
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: height, alignment: .top)
        .background(selected ? item.tint : item.tint.opacity(item.isTask ? 0.08 : 0.16))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay { outline }
        .opacity(dragging ? 0.85 : 1)
        .shadow(color: .black.opacity(dragging ? 0.25 : 0), radius: dragging ? 8 : 0, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier(CalendarIdentifiers.item(item.id))
        .sempTarget(of: item, meta: timeText)
    }
}

// MARK: - Layout
extension CalendarTimedItemView {

    /// What a block of a given height has room for: a chip under about 40 points says its title alone, as the system
    /// Calendar's does, one with room for a second line adds the time, and a tall one the place and the tasks.
    enum Layout {

        static func showsTime(_ height: CGFloat) -> Bool { height >= 38 }

        static func showsDetails(_ height: CGFloat) -> Bool { height >= 64 }

        /// How many of an event's tasks fit under its title and time.
        static func taskRows(_ height: CGFloat) -> Int { max(Int((height - 54) / 16), 0) }

        static func titleLines(_ height: CGFloat) -> Int { height >= 64 ? 2 : 1 }

        static func verticalPadding(_ height: CGFloat) -> CGFloat { height < 30 ? 2 : 4 }

        static func checkboxTop(_ height: CGFloat) -> CGFloat { height < 30 ? 2 : 4 }
    }
}

// MARK: - Subviews
private extension CalendarTimedItemView {

    var header: some View {
        HStack(spacing: 4) {
            Text(item.displayTitle)
                .font(.caption.weight(.semibold))
                .strikethrough(item.done)
                .foregroundStyle(titleStyle)
                .lineLimit(Layout.titleLines(height))
            if !item.tasks.isEmpty {
                Text("\(item.tasks.filter(\.isDone).count)/\(item.tasks.count)")
                    .font(.caption2)
                    .foregroundStyle(secondaryStyle)
            }
            if item.tentative {
                Image(systemName: "questionmark.circle").font(.caption2).foregroundStyle(secondaryStyle)
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
                .foregroundStyle(task.isDone ? secondaryStyle : titleStyle)
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

    /// A held block is the colour of its calendar all through, with white words, as in the system Calendar.
    var titleStyle: AnyShapeStyle {
        if selected { return AnyShapeStyle(Color.white) }
        return item.done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    var secondaryStyle: AnyShapeStyle {
        selected ? AnyShapeStyle(Color.white.opacity(0.85)) : AnyShapeStyle(.secondary)
    }

    @ViewBuilder var outline: some View {
        let shape = RoundedRectangle(cornerRadius: 6)
        if item.isGhost {
            shape.strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        } else if dropTarget {
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
