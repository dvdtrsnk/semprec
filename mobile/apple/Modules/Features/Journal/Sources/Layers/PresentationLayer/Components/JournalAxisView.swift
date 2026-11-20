import CoreKit
import DesignSystem
import SwiftUI

/// The time axis of the diary: a row of years, quarters, months and days that move together. All rows show the same
/// moment in their middle, each at its own scale, so a day sits under its month, the month under its quarter and the
/// quarter under its year. Each row is a plain horizontal scroll view: the row the person scrolls sets the moment, and
/// every other row is placed under it at once, without an animation of its own; a tap selects a period. The rows hold
/// a window of periods around the selection; a scroll that comes to rest near the edge of the days asks for the
/// windows around the day it reached (`onMove`). The diary may show the rows apart, each part its own view over all
/// `rows`: the parts share one `motion`, so they still move together.
struct JournalAxisView: View {

    // MARK: - Dependencies
    let rows: [JournalAxisRow]
    /// The rows this part of the axis shows.
    let shown: [JournalAxisRow]
    let selectionStart: String
    let selectionKind: JournalPeriodKind
    let onSelect: (JournalAxisCell) -> Void
    let onMove: (String) -> Void

    // MARK: - State
    /// Where the axis stands and which row the person scrolls, shared by every part of the axis.
    @Binding var motion: JournalAxisMotion

    // MARK: - Body
    var body: some View {
        // Every part holds every row and folds away the ones it does not show, so a row is never made anew when the
        // selected level moves it to another part: it is already where the others are.
        VStack(spacing: 0) {
            ForEach(rows) { row in
                let isShown = shown.contains { $0.kind == row.kind }
                JournalAxisRowView(
                    row: row,
                    track: JournalAxisTrack(row: row),
                    cursor: currentCursor,
                    motion: $motion,
                    onSelect: select,
                    onRest: settle
                )
                .accessibilityAdjustableAction { direction in adjust(row: row, direction: direction) }
                .padding(.vertical, isShown ? Self.rowSpacing / 2 : 0)
                .frame(height: isShown ? nil : 0, alignment: .top)
                .clipped()
                .opacity(isShown ? 1 : 0)
                .allowsHitTesting(isShown)
                .accessibilityHidden(!isShown)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("journal.axis.label", bundle: .module))
        .onChange(of: selectionStart) { _, _ in center() }
        .onChange(of: selectionKind) { _, _ in center() }
        .onChange(of: motion.centerRequests) { _, _ in center() }
        .onChange(of: rows) { _, _ in returnIfOutside() }
    }

    private var currentCursor: Double {
        motion.cursor ?? anchor
    }

    /// Where the axis rests for the selection: the middle of a day, or about the middle of a longer period.
    private var anchor: Double {
        guard let start = JournalAxisTrack.epochDay(selectionStart) else { return 0 }
        guard let row = rows.first(where: { $0.kind == selectionKind }),
              let span = JournalAxisTrack(row: row).span(startingAt: start) else { return start + 0.5 }
        return start + min(Self.longPeriodAnchor, span / 2)
    }
}

// MARK: - Motion
/// Where the axis stands and which row moves it.
struct JournalAxisMotion: Equatable {

    /// The moment in the middle of every row, in days since 1970 (a fraction is a part of the day).
    var cursor: Double?
    /// The row the person is scrolling; the other rows follow it. `nil` while no row is scrolled by hand.
    var driver: JournalPeriodKind?
    /// Whether the rows move to the next cursor with the system's scroll animation: only for a jump the person asked
    /// for, such as a tap on a period or Today.
    var animated = false
    /// Counts the requests to scroll the selected period back to the middle, such as Today on today.
    var centerRequests = 0
}

// MARK: - Movement
private extension JournalAxisView {

    /// Scrolls every row so that the selected period is in the middle of the screen.
    func center() {
        jump(to: anchor, animated: true)
    }

    /// A tap selects the period; one on the period already selected scrolls it back to the middle.
    func select(_ cell: JournalAxisCell) {
        if cell.current { center() }
        onSelect(cell)
    }

    /// The windows moved back to the selection (the person asked for it again, or for today): when the cursor is no
    /// longer inside them, the axis returns to the selection.
    func returnIfOutside() {
        guard let cursor = motion.cursor, let range = cursorRange, !range.contains(cursor) else { return }
        jump(to: anchor, animated: false)
    }

    func jump(to cursor: Double, animated: Bool) {
        motion.driver = nil
        motion.animated = animated
        motion.cursor = cursor
    }

    /// A scroll came to rest: near the edge of the days, the windows move with it.
    func settle() {
        guard let cursor = motion.cursor, let range = cursorRange else { return }
        if cursor - range.lowerBound < Self.edgeDays || range.upperBound - cursor < Self.edgeDays {
            onMove(JournalAxisTrack.key(cursor))
        }
    }

    func adjust(row: JournalAxisRow, direction: AccessibilityAdjustmentDirection) {
        let step = row.kind.typicalSpan
        switch direction {
        case .increment: jump(to: clamped(currentCursor + step), animated: false)
        case .decrement: jump(to: clamped(currentCursor - step), animated: false)
        @unknown default: break
        }
    }

    func clamped(_ value: Double) -> Double {
        guard let range = cursorRange else { return value }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    /// Where every row, the days included, has periods under the cursor.
    var cursorRange: ClosedRange<Double>? {
        let bounds = rows.compactMap { row in JournalAxisTrack(row: row).bounds }
        guard let lower = bounds.map(\.lowerBound).max(), let upper = bounds.map(\.upperBound).min(),
              lower < upper else { return nil }
        return lower...upper
    }

    static let rowSpacing: CGFloat = 2
    /// How close to the edge of the days a scroll may rest before the windows move: about a quarter of a year.
    static let edgeDays: Double = 100
    /// A longer period rests about half a month in, as in the design.
    static let longPeriodAnchor: Double = 15.5
}

// MARK: - Track
/// The cells of one row on the time line: where each period starts and ends, in days since 1970.
@MainActor
private struct JournalAxisTrack {

    let starts: [Double]
    let ends: [Double]

    init(row: JournalAxisRow) {
        let starts = row.cells.map { Self.epochDay($0.start) ?? 0 }
        self.starts = starts
        ends = starts.indices.map { index in
            index + 1 < starts.count ? starts[index + 1] : starts[index] + row.kind.typicalSpan
        }
    }

    var bounds: ClosedRange<Double>? {
        guard let first = starts.first, let last = ends.last, first < last else { return nil }
        return first...last
    }

    /// The length of the period that starts on `start`, if the row has it.
    func span(startingAt start: Double) -> Double? {
        starts.firstIndex(of: start).map { ends[$0] - starts[$0] }
    }

    /// The moment at `position` in cells, the inverse of `position(of:)`.
    func moment(at position: Double) -> Double {
        guard !starts.isEmpty else { return 0 }
        let index = min(max(Int(position.rounded(.down)), 0), starts.count - 1)
        return starts[index] + (position - Double(index)) * (ends[index] - starts[index])
    }

    /// The position of `cursor` in cells: 3.5 is the middle of the fourth cell.
    func position(of cursor: Double) -> Double {
        guard !starts.isEmpty else { return 0 }
        var low = 0
        var high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= cursor { low = mid } else { high = mid - 1 }
        }
        let length = max(ends[low] - starts[low], 1)
        return Double(low) + (cursor - starts[low]) / length
    }

    static func epochDay(_ key: String) -> Double? {
        JournalDates.date(key).map { ($0.timeIntervalSince1970 / secondsPerDay).rounded() }
    }

    /// The day `YYYY-MM-DD` that `epochDay` falls in.
    static func key(_ epochDay: Double) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let date = Date(timeIntervalSince1970: epochDay.rounded(.down) * secondsPerDay)
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    private static let secondsPerDay: Double = 86_400
}

// MARK: - Row
/// One row of the axis as a horizontal scroll view. The cells sit side by side at the row's width each, with half the
/// row's width of room at both ends, so a scroll offset of `x` puts the point `x` of the cells in the middle.
private struct JournalAxisRowView: View {

    // MARK: - Dependencies
    let row: JournalAxisRow
    let track: JournalAxisTrack
    let cursor: Double
    @Binding var motion: JournalAxisMotion
    let onSelect: (JournalAxisCell) -> Void
    let onRest: () -> Void

    // MARK: - State
    @State private var position = ScrollPosition()
    @State private var width: CGFloat = 0

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(row.cells) { cell in
                    Button { onSelect(cell) } label: { JournalAxisCellLabel(cell: cell) }
                        .buttonStyle(.plain)
                        .frame(width: row.kind.width)
                        .accessibilityLabel(Text(cell.accessibilityTitle))
                        .accessibilityAddTraits(cell.current ? .isSelected : [])
                        .accessibilityIdentifier(cell.identifier)
                }
            }
            // Its exact width up front, so a scroll to a far period is not cut short by a lazy estimate of it.
            .frame(width: CGFloat(row.cells.count) * row.kind.width, alignment: .leading)
            .padding(.horizontal, width / 2)
        }
        .scrollIndicators(.hidden)
        .scrollPosition($position)
        .frame(height: row.kind.height)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { newWidth in
            width = newWidth
            place(animated: false)
        })
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.x }, action: { _, offset in
            guard motion.driver == row.kind else { return }
            motion.cursor = track.moment(at: offset / row.kind.width)
        })
        .onScrollPhaseChange { _, phase in
            switch phase {
            case .interacting:
                motion.animated = false
                motion.driver = row.kind
            case .idle where motion.driver == row.kind:
                motion.driver = nil
                onRest()
            default:
                break
            }
        }
        .onChange(of: cursor) { _, _ in
            guard motion.driver != row.kind else { return }
            place(animated: motion.animated)
        }
        .onChange(of: row) { _, _ in place(animated: false) }
        // The row takes its place once it is laid out.
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentSize.width }, action: { _, _ in
            guard motion.driver != row.kind else { return }
            place(animated: false)
        })

        .mask {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: Self.fade),
                    .init(color: .black, location: 1 - Self.fade),
                    .init(color: .clear, location: 1)
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
    }

    /// Scrolls the row so that the cursor is in its middle.
    private func place(animated: Bool) {
        let offset = track.position(of: cursor) * row.kind.width
        if animated {
            withAnimation { position.scrollTo(x: offset) }
        } else {
            position.scrollTo(x: offset)
        }
    }

    /// The share of the width at each edge where the cells fade out, as in the design.
    private static let fade: CGFloat = 0.14
}
