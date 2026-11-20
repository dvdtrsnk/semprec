import CoreKit
import DesignSystem
import SwiftUI

/// The time axis of the diary: a row of years, quarters, months and days that move together. All rows show the same
/// moment in their middle, each at its own scale, so a day sits under its month, the month under its quarter and the
/// quarter under its year. Dragging any row moves the moment, and every row with it; a tap selects a period. The
/// selection and the periods that contain it are marked, today is in the accent colour. The rows hold a window of
/// periods around the selection; a drag that ends near the edge of the days asks for the windows around the day it
/// reached (`onMove`). The diary may show the rows apart, each part its own view over all `rows`: the parts share one
/// `motion`, so they still move together.
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
    /// Where the axis stands and how it is being dragged, shared by every part of the axis.
    @Binding var motion: JournalAxisMotion

    private var cursor: Double? {
        get { motion.cursor }
        nonmutating set { motion.cursor = newValue }
    }
    private var dragOrigin: Double? {
        get { motion.dragOrigin }
        nonmutating set { motion.dragOrigin = newValue }
    }
    private var dragged: Bool {
        get { motion.dragged }
        nonmutating set { motion.dragged = newValue }
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: Self.rowSpacing) {
            ForEach(shown) { row in rowView(row) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("journal.axis.label", bundle: .module))
        .onChange(of: selectionStart) { _, _ in follow(animated: true) }
        .onChange(of: rows) { _, _ in returnIfOutside() }
        .onAppear { follow(animated: false) }
    }

    private func rowView(_ row: JournalAxisRow) -> some View {
        JournalAxisRowView(
            row: row,
            track: JournalAxisTrack(row: row),
            cursor: currentCursor,
            onSelect: { cell in
                guard !dragged else { return }
                onSelect(cell)
                glide(to: cell.start, kind: cell.kind)
            }
        )
        .highPriorityGesture(drag(scale: row.kind.daysPerPoint))
        .accessibilityAdjustableAction { direction in adjust(row: row, direction: direction) }
    }

    private var currentCursor: Double {
        cursor ?? anchor
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
/// Where the axis stands and how it is being dragged.
struct JournalAxisMotion: Equatable {

    /// The moment in the middle of every row, in days since 1970 (a fraction is a part of the day).
    var cursor: Double?
    /// The cursor when the running drag began.
    var dragOrigin: Double?
    /// True from the start of a drag until just after it ended: the cell under the finger moved with it, so lifting
    /// the finger must not count as a tap on that cell.
    var dragged = false
}

// MARK: - Movement
private extension JournalAxisView {

    func drag(scale: Double) -> some Gesture {
        DragGesture(minimumDistance: Self.dragThreshold)
            .onChanged { value in
                let origin = dragOrigin ?? currentCursor
                dragOrigin = origin
                dragged = true
                cursor = clamped(origin - value.translation.width * scale)
            }
            .onEnded { value in
                let origin = dragOrigin ?? currentCursor
                dragOrigin = nil
                let target = clamped(origin - value.predictedEndTranslation.width * scale)
                withAnimation(.smooth(duration: Self.glideDuration)) { cursor = target }
                Task { @MainActor in dragged = false }
                if nearEdge(target) { onMove(JournalAxisTrack.key(target)) }
            }
    }

    /// Brings the selected period into the middle, unless the axis already shows it there.
    func follow(animated: Bool) {
        glide(to: selectionStart, kind: selectionKind, animated: animated)
    }

    /// Brings the period of `kind` that starts on `start` into the middle, unless the axis already shows it there.
    func glide(to start: String, kind: JournalPeriodKind, animated: Bool = true) {
        guard let first = JournalAxisTrack.epochDay(start) else { return }
        let span = rows.first(where: { $0.kind == kind })
            .flatMap { JournalAxisTrack(row: $0).span(startingAt: first) } ?? 1
        if let cursor, cursor >= first, cursor < first + span { return }
        withAnimation(animated ? .smooth(duration: Self.glideDuration) : nil) {
            cursor = first + (kind == .day ? 0.5 : min(Self.longPeriodAnchor, span / 2))
        }
    }

    /// The windows moved back to the selection (the person asked for it again, or for today): when the cursor is no
    /// longer inside them, the axis returns to the selection.
    func returnIfOutside() {
        guard let cursor, let range = cursorRange, !range.contains(cursor) else { return }
        withAnimation(.smooth(duration: Self.glideDuration)) { self.cursor = anchor }
    }

    func adjust(row: JournalAxisRow, direction: AccessibilityAdjustmentDirection) {
        let step = row.kind.daysPerPoint * row.kind.width
        switch direction {
        case .increment: cursor = clamped(currentCursor + step)
        case .decrement: cursor = clamped(currentCursor - step)
        @unknown default: break
        }
    }

    /// Keeps the cursor where every row, the days included, still fills the width around it.
    func clamped(_ value: Double) -> Double {
        guard let range = cursorRange else { return value }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    /// Whether the cursor came so close to the edge of the days that the windows should move with it.
    func nearEdge(_ value: Double) -> Bool {
        guard let range = cursorRange else { return false }
        return value - range.lowerBound < Self.edgeDays || range.upperBound - value < Self.edgeDays
    }

    private var cursorRange: ClosedRange<Double>? {
        let bounds = rows.compactMap { row in JournalAxisTrack(row: row).bounds }
        guard let lower = bounds.map(\.lowerBound).max(), let upper = bounds.map(\.upperBound).min(),
              lower + Self.margin < upper - Self.margin else { return nil }
        return (lower + Self.margin)...(upper - Self.margin)
    }

    static let dragThreshold: CGFloat = 6
    static let rowSpacing: CGFloat = 2
    /// About half the width of the row of days, so the row never shows empty space at an edge.
    static let margin: Double = 6
    /// How close to the edge of the days a drag may end before the windows move: about a quarter of a year.
    static let edgeDays: Double = 100
    static let glideDuration: Double = 0.35
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
private struct JournalAxisRowView: View {

    // MARK: - Dependencies
    let row: JournalAxisRow
    let track: JournalAxisTrack
    let cursor: Double
    let onSelect: (JournalAxisCell) -> Void

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let middle = proxy.size.width / 2
            let position = track.position(of: cursor)
            let reach = Double(middle / row.kind.width) + 1
            ZStack(alignment: .topLeading) {
                ForEach(Array(row.cells.enumerated()), id: \.element.id) { index, cell in
                    if abs(Double(index) - position) <= reach + 1 {
                        Button { onSelect(cell) } label: { JournalAxisCellLabel(cell: cell) }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(cell.accessibilityTitle))
                            .accessibilityAddTraits(cell.current ? .isSelected : [])
                            .accessibilityIdentifier(cell.identifier)
                            .offset(x: middle + (Double(index) - position) * row.kind.width)
                    }
                }
            }
        }
        .frame(height: row.kind.height)
        .clipped()
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
        .contentShape(.rect)
    }

    /// The share of the width at each edge where the cells fade out, as in the design.
    private static let fade: CGFloat = 0.14
}
