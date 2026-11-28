import SwiftUI

/// How a view of the calendar looks partway into or out of a change of zoom: scaled about `anchor`, moved down by
/// `offset`, and shown by `share`. A month that keeps its row of the selected day (`keepsRow`, in a change to or from
/// a day) fades only its other parts, through `calendarZoomShare`; any other view fades as a whole. At rest it is
/// shown whole and adds no offscreen pass.
struct CalendarZoomEffect: ViewModifier {

    // MARK: - Properties
    var scale: CGFloat = 1
    var anchor: UnitPoint = .center
    var offset: CGFloat = 0
    var share: Double = 0
    var keepsRow = false

    /// The same view at rest, fully shown, which this look animates from or to.
    var shown: Self {
        Self(anchor: anchor, share: 1, keepsRow: keepsRow)
    }

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .modifier(CalendarZoomShare(share: keepsRow ? share : 1))
            .opacity(keepsRow ? 1 : share)
            .scaleEffect(scale, anchor: anchor)
            .offset(y: offset)
    }
}

/// Hands the share of a change of zoom down to the parts of a view that fade with it, frame by frame.
private struct CalendarZoomShare: ViewModifier, Animatable {

    var share: Double

    nonisolated var animatableData: Double {
        get { share }
        set { share = newValue }
    }

    func body(content: Content) -> some View {
        content.environment(\.calendarZoomShare, share)
    }
}

/// Fades a part of a month in a change to or from a day, unless it is the part that stays (`isKept`).
struct CalendarZoomFade: ViewModifier {

    var isKept = false
    @Environment(\.calendarZoomShare)
    private var share

    func body(content: Content) -> some View {
        content.opacity(isKept ? 1 : share)
    }
}

// MARK: - Environment
extension EnvironmentValues {

    /// How much of a month's parts beside its row of the selected day shows while it changes to or from a day.
    @Entry var calendarZoomShare: Double = 1
}
