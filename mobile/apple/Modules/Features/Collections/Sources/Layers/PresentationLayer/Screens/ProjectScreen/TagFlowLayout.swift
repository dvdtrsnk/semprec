import SwiftUI

/// Places its subviews in rows from the leading edge, starting a new row where the next one no longer fits, the way
/// the tags of a reminder wrap.
struct TagFlowLayout: Layout {

    // MARK: - Dependencies
    var spacing: CGFloat

    // MARK: - Layout
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let rows = Self.rows(of: sizes, width: proposal.width, spacing: spacing)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        var top = bounds.minY
        for row in Self.rows(of: sizes, width: bounds.width, spacing: spacing) {
            var leading = bounds.minX
            for index in row.indices {
                let size = sizes[index]
                subviews[index].place(
                    at: CGPoint(x: leading, y: top + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                leading += size.width + spacing
            }
            top += row.height + spacing
        }
    }

    // MARK: - Methods
    /// The rows `sizes` fall into within `width`; a nil width keeps every size on one row, and a size wider than the
    /// width takes a row of its own.
    static func rows(of sizes: [CGSize], width: CGFloat?, spacing: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for (index, size) in sizes.enumerated() {
            let widened = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if let width, !current.indices.isEmpty, widened > width {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }

    /// One row of the layout: the subviews it holds, its width and the height of its tallest subview.
    struct Row: Equatable {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }
}
