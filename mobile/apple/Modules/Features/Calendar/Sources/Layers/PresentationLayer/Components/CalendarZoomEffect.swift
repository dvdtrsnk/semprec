import SwiftUI

/// How a view of the calendar looks partway into or out of a change of zoom: scaled about `anchor`, moved down by
/// `offset`, and shown by `share`, all of it but `keptRow`, a band across the view that stays whole (the row of the
/// selected day in a month, which slides between its place and the day's week strip).
struct CalendarZoomEffect: ViewModifier {

    // MARK: - Properties
    var scale: CGFloat = 1
    var anchor: UnitPoint = .center
    var offset: CGFloat = 0
    var share: Double = 0
    var keptRow: CGRect = .zero

    /// How far past the view's bounds the mask reaches on every side.
    private static let overscan: CGFloat = 1_000

    /// The same view at rest, fully shown, which this look animates from or to.
    var shown: Self {
        Self(anchor: anchor, share: 1, keptRow: keptRow)
    }

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .mask {
                ZStack(alignment: .topLeading) {
                    Color.black.opacity(share)
                    Color.black
                        .frame(height: keptRow.height)
                        .offset(y: keptRow.minY + Self.overscan)
                }
                // The mask reaches past the view's bounds, so what a view draws beyond them (the day's header
                // backdrop under the toolbar) is not cut off.
                .padding(-Self.overscan)
            }
            .scaleEffect(scale, anchor: anchor)
            .offset(y: offset)
    }
}
