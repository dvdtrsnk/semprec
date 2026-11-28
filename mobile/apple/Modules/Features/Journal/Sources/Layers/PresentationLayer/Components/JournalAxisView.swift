import CoreKit
import DesignSystem
import SwiftUI

/// The time axis of the diary: a row of years, months and days that move together, three horizontal scroll views and
/// nothing more. All rows show the same moment in their middle, each at its own scale, so a day sits under its month
/// and the month under its year.
///
/// One row moves at a time and the other two follow it, frame by frame: the row the person scrolls by hand, or the row
/// that scrolls itself with the system's scroll animation to a period the person tapped (or to the selection, after
/// Today). Every period a row shows has its days in the row of days, so a scroll never runs past the end of another
/// row. The rows keep their identity whatever is selected; the row of the selected level is pinned to the top of the
/// page while the page passes under it. A scroll that comes to rest near the edge of the windows asks for windows
/// around the day it reached (`onMove`); the cells change only then, at rest.
///
/// The axis lies on `material`, one solid layer from the top of the screen down to a divider under the last row. As
/// the page scrolls, the layer's lower edge goes up with the rows until it reaches the pinned row, and stays under it
/// from then on; the rows below the pinned one pass under the pinned row, and the rows above it go up under the
/// material the screen keeps over its top. A divider lies under the pinned row too, so a pinned month or year is set
/// off from the rows below.
struct JournalAxisView<Material: View>: View {

    // MARK: - Dependencies
    let rows: [JournalAxisRow]
    let selectionStart: String
    let selectionKind: JournalPeriodKind
    /// How far above the axis the material reaches: up past the top of the screen, whatever the page shows above.
    let materialReach: CGFloat
    let onSelect: (JournalAxisCell) -> Void
    let onMove: (String) -> Void
    /// Told `true` when a row starts to move the axis and `false` when the axis comes to rest.
    let onMoving: (Bool) -> Void
    /// The solid layer the axis lies on.
    @ViewBuilder let material: () -> Material

    // MARK: - State
    @Binding var motion: JournalAxisMotion
    /// The rows' tracks, worked out once for each window rather than on every frame of a scroll.
    @State private var tracks = JournalAxisTracks()

    // MARK: - Body
    var body: some View {
        // The rows lie one under another at fixed places, drawn with the pinned row last: on top of the rows and the
        // page that pass under it.
        ZStack(alignment: .top) {
            ForEach(drawingOrder) { row in
                let isPinned = row.kind == selectionKind
                JournalAxisRowView(
                    row: row,
                    track: tracks.track(for: row),
                    cursor: motion.cursor ?? anchor,
                    motion: $motion,
                    onSelect: onSelect,
                    onRest: settle
                )
                .accessibilityAdjustableAction { direction in adjust(row: row, direction: direction) }
                .padding(.vertical, Self.rowSpacing / 2)
                .padding(.bottom, dividerGap(under: row.kind))
                // The pinned row carries its own strip of the material, so the rows below pass under it.
                .background {
                    if isPinned { material() }
                }
                .overlay(alignment: .bottom) {
                    if isPinned { JournalDivider() }
                }
                .pinned(isPinned)
                .padding(.top, top(of: row.kind))
            }
        }
        .background(alignment: .bottom) {
            material()
                .overlay(alignment: .bottom) { JournalDivider() }
                .frame(height: materialReach + axisHeight)
                .rising(axisHeight: axisHeight, pinnedTop: top(of: selectionKind), below: belowPinned)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("journal.axis.label", bundle: .module))
        .onChange(of: windowStart) { _, _ in returnIfOutside() }
        .onChange(of: selectionStart) { _, _ in follow() }
        .onChange(of: selectionKind) { _, _ in follow() }
        .onChange(of: motion.centerRequests) { _, _ in center() }
        .onChange(of: motion.driver != nil) { _, moving in onMoving(moving) }
    }

    /// The moment the axis rests on for the selection: the middle of the selected period's cell.
    private var anchor: Double {
        if let row = rows.first(where: { $0.kind == selectionKind }),
           let index = row.cells.firstIndex(where: { $0.start == selectionStart }) {
            return tracks.track(for: row).middle(of: index)
        }
        return (JournalAxisTrack.epochDay(selectionStart) ?? 0) + 0.5
    }

    /// The rows in the order they are drawn: the pinned row last, so it lies over the others.
    private var drawingOrder: [JournalAxisRow] {
        rows.filter { $0.kind != selectionKind } + rows.filter { $0.kind == selectionKind }
    }

    /// How far down the axis the row of `kind` lies: under the rows of the wider levels.
    private func top(of kind: JournalPeriodKind) -> CGFloat {
        rows.prefix { $0.kind != kind }.reduce(0) { $0 + height(of: $1.kind) }
    }

    /// The height a row takes on the axis, with the room above a divider under it.
    private func height(of kind: JournalPeriodKind) -> CGFloat {
        kind.height + Self.rowSpacing + dividerGap(under: kind)
    }

    /// The room between a row and the divider under it, as between the calendar's week strip and its divider: under
    /// the selected row and under the last row, where the material ends.
    private func dividerGap(under kind: JournalPeriodKind) -> CGFloat {
        kind == selectionKind || kind == rows.last?.kind ? Self.dividerGap : 0
    }

    /// The height of all the rows.
    private var axisHeight: CGFloat {
        rows.reduce(0) { $0 + height(of: $1.kind) }
    }

    /// How far the axis reaches below the pinned row: the rows of the narrower levels.
    private var belowPinned: CGFloat {
        axisHeight - top(of: selectionKind) - height(of: selectionKind)
    }

    /// The first day of the windows, which changes only when the windows move.
    private var windowStart: String? {
        rows.last?.cells.first?.start
    }
}

// MARK: - Motion
/// Where the axis stands, which row moves it and the scroll the selected row is asked to make.
struct JournalAxisMotion: Equatable {

    /// The moment in the middle of every row, in days since 1970 (a fraction is a part of the day). `nil` until a row
    /// first moves: the rows then rest on the selection.
    var cursor: Double?
    /// The row that moves the axis, by hand or by its own scroll animation; the other rows follow it. `nil` at rest.
    var driver: JournalPeriodKind?
    /// The animated scroll a row is asked to make to a moment, such as the selection after Today.
    var request: JournalAxisScrollRequest?
    /// Counts the requests to scroll the selected period back to the middle, such as Today on today.
    var centerRequests = 0
}

/// A request to the row of `kind` to scroll itself, animated, until `target` is in its middle. `id` tells two
/// requests to the same target apart.
struct JournalAxisScrollRequest: Equatable {

    let id: Int
    let kind: JournalPeriodKind
    let target: Double
}

// MARK: - Movement
private extension JournalAxisView {

    /// Scrolls the selected row, animated, until the selected period is in the middle; the other rows follow it.
    func center() {
        let next = (motion.request?.id ?? 0) + 1
        motion.request = JournalAxisScrollRequest(id: next, kind: selectionKind, target: anchor)
    }

    /// The selection changed. A tap already scrolls its own row to the period; any other change (Today) scrolls the
    /// selected row to it.
    func follow() {
        guard motion.driver == nil else { return }
        center()
    }

    /// The windows moved: when the cursor is no longer inside them (Today far away), the axis stands on the selection.
    func returnIfOutside() {
        guard let cursor = motion.cursor, let range = cursorRange, !range.contains(cursor) else { return }
        motion.driver = nil
        motion.cursor = anchor
    }

    /// A scroll came to rest: near the edge of the windows, they move around the moment it reached.
    func settle() {
        guard let cursor = motion.cursor, let range = cursorRange else { return }
        if cursor - range.lowerBound < Self.edgeDays || range.upperBound - cursor < Self.edgeDays {
            onMove(JournalAxisTrack.key(cursor))
        }
    }

    func adjust(row: JournalAxisRow, direction: AccessibilityAdjustmentDirection) {
        let step = row.kind.typicalSpan
        let cursor = motion.cursor ?? anchor
        motion.driver = nil
        switch direction {
        case .increment: motion.cursor = clamped(cursor + step)
        case .decrement: motion.cursor = clamped(cursor - step)
        @unknown default: break
        }
    }

    func clamped(_ value: Double) -> Double {
        guard let range = cursorRange else { return value }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    /// Where every row has periods under the cursor.
    var cursorRange: ClosedRange<Double>? {
        let bounds = rows.compactMap { row in tracks.track(for: row).bounds }
        guard let lower = bounds.map(\.lowerBound).max(), let upper = bounds.map(\.upperBound).min(),
              lower < upper else { return nil }
        return lower...upper
    }

    static var rowSpacing: CGFloat { 2 }
    static var dividerGap: CGFloat { 3 }
    /// How close to the edge of the windows a scroll may rest before they move: a year, so that the periods around
    /// the one in the middle are always there.
    static var edgeDays: Double { 365 }
}

// MARK: - Pinning
private extension View {

    /// Keeps the view at the top of the enclosing scroll view's content, just under its top inset, once the page
    /// scrolls it there, while `isPinned`. The scroll view's coordinate space starts at the inset. The offset is a
    /// visual effect, worked out from the view's place in the scroll view as each frame is drawn, so the view stays
    /// exactly in step with the scroll and the page's own state never changes while it scrolls. The effect is always
    /// there, only its offset depends on `isPinned`: a row that becomes pinned stays the same view, and its scroll
    /// view keeps its place.
    func pinned(_ isPinned: Bool) -> some View {
        visualEffect { content, proxy in
            content.offset(y: isPinned ? max(0, -proxy.frame(in: .scrollView).minY) : 0)
        }
    }

    /// The material under the axis, whose lower edge is the axis's: it rises with the rows until it reaches the
    /// pinned row (`pinnedTop` down the axis, `below` above the axis's end), and stays under it from then on.
    func rising(axisHeight: CGFloat, pinnedTop: CGFloat, below: CGFloat) -> some View {
        visualEffect { content, proxy in
            let pinnedRow = proxy.frame(in: .scrollView).maxY - axisHeight + pinnedTop
            let pinnedShift = max(0, -pinnedRow)
            return content.offset(y: max(0, pinnedShift - below))
        }
    }
}
