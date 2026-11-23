import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Row
/// One row of the axis as a horizontal scroll view. The cells sit side by side at the row's width each, with half the
/// row's width of room at both ends, so a scroll offset of `x` puts the point `x` of the cells in the middle.
struct JournalAxisRowView: View {

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
    /// The row's own offset as it last scrolled, kept out of the view's state so reading it never redraws the row.
    @State private var offset = JournalAxisOffset()

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal) {
            JournalAxisCells(row: row, onTap: tap)
                .equatable()
                // Its exact width up front, so a scroll to a far period is not cut short by a lazy estimate of it.
                .frame(width: CGFloat(row.cells.count) * row.kind.width, alignment: .leading)
                .padding(.horizontal, width / 2)
        }
        .scrollIndicators(.hidden)
        .scrollPosition($position)
        .frame(height: row.kind.height)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { newWidth in
            width = newWidth
            follow()
        })
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.x }, action: { _, newOffset in
            offset.value = newOffset
            guard motion.driver == row.kind else { return }
            motion.cursor = track.moment(at: newOffset / row.kind.width)
        })
        .onScrollPhaseChange { _, phase in
            switch phase {
            case .interacting:
                motion.driver = row.kind
            case .idle where motion.driver == row.kind:
                motion.driver = nil
                onRest()
            default:
                break
            }
        }
        .onChange(of: cursor) { _, _ in follow() }
        .onChange(of: track.starts) { _, _ in follow() }
        .onChange(of: motion.request) { _, request in
            guard let request, request.kind == row.kind else { return }
            scroll(to: request.target)
        }
        // The row takes its place once it is laid out.
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentSize.width }, action: { _, _ in follow() })
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

    /// A tap scrolls the row until the tapped period is exactly in the middle, then selects it.
    private func tap(_ cell: JournalAxisCell) {
        if let index = row.cells.firstIndex(where: { $0.id == cell.id }) {
            scroll(to: track.middle(of: index))
        }
        onSelect(cell)
    }

    /// Scrolls this row, with the system's scroll animation, until `target` is in its middle; the other rows follow
    /// it frame by frame. A row already there only sets the cursor.
    private func scroll(to target: Double) {
        let destination = track.position(of: target) * row.kind.width
        guard abs(destination - offset.value) >= Self.restTolerance else {
            motion.driver = nil
            motion.cursor = target
            return
        }
        motion.driver = row.kind
        withAnimation(.smooth) { position.scrollTo(x: destination) }
    }

    /// Places a following row under the cursor at once. The moving row is never placed: it moves itself.
    private func follow() {
        guard motion.driver != row.kind else { return }
        let destination = track.position(of: cursor) * row.kind.width
        guard abs(destination - offset.value) >= Self.placeTolerance else { return }
        // The moving row's animation must not carry over: a following row is placed, never animated, or it would
        // trail the row it follows with an animation of its own.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { position.scrollTo(x: destination) }
    }

    /// The share of the width at each edge where the cells fade out, as in the design.
    private static let fade: CGFloat = 0.14
    /// A scroll shorter than this, in points, is not animated.
    private static let restTolerance: CGFloat = 0.5
    /// A following row closer than this to its place is not moved.
    private static let placeTolerance: CGFloat = 0.01
}

/// The latest offset of a row, held by reference so the row reads it without depending on it.
final class JournalAxisOffset {

    var value: CGFloat = .nan
}

/// The cells of one row. They depend on the row alone, so a row that scrolls redraws none of them.
struct JournalAxisCells: View, Equatable {

    let row: JournalAxisRow
    let onTap: (JournalAxisCell) -> Void
    /// What tells two rows apart, so comparing them does not compare thousands of cells on every frame.
    private let signature: JournalAxisRowSignature

    init(row: JournalAxisRow, onTap: @escaping (JournalAxisCell) -> Void) {
        self.row = row
        self.onTap = onTap
        signature = JournalAxisRowSignature(row: row)
    }

    var body: some View {
        LazyHStack(spacing: 0) {
            ForEach(row.cells) { cell in
                Button { onTap(cell) } label: { JournalAxisCellLabel(cell: cell) }
                    .buttonStyle(.plain)
                    .frame(width: row.kind.width)
                    .accessibilityLabel(Text(cell.accessibilityTitle))
                    .accessibilityAddTraits(cell.current ? .isSelected : [])
                    .accessibilityIdentifier(cell.identifier)
            }
        }
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.signature == rhs.signature
    }
}

/// A row in brief: its window (consecutive periods, so the first one and their count) and the cells that stand out,
/// the only ones a change of selection or of today changes.
struct JournalAxisRowSignature: Equatable, Sendable {

    let kind: JournalPeriodKind
    let first: String?
    let count: Int
    let current: Int?
    let onPath: Int?
    let today: Int?

    init(row: JournalAxisRow) {
        kind = row.kind
        first = row.cells.first?.start
        count = row.cells.count
        var current: Int?
        var onPath: Int?
        var today: Int?
        for (index, cell) in row.cells.enumerated() {
            if cell.current { current = index }
            if cell.onPath { onPath = index }
            if cell.today { today = index }
        }
        self.current = current
        self.onPath = onPath
        self.today = today
    }
}
