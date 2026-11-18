import SwiftUI

/// Zooms the timeline with two fingers held one above the other: spreading them makes every hour, and every item on
/// it, taller, closing them fits more of the day on the screen. The hour height follows the vertical distance of the
/// fingers within the range `CalendarGeometry` allows. Fingers that come down side by side do not zoom. It goes on
/// the day pager rather than on a day's own scroll, so it never holds back the sideways scroll between days.
struct CalendarVerticalPinch: ViewModifier {

    // MARK: - Dependencies
    @Binding var hourHeight: Double
    /// Where the fingers are, in global coordinates, while a zoom is under way.
    @Binding var pinchY: CGFloat?

    // MARK: - State
    @State private var start: Start?
    @State private var isRejected = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content.simultaneousGesture(zoom)
    }
}

// MARK: - Private
private extension CalendarVerticalPinch {

    /// The hour height and the vertical distance of the fingers when the zoom began.
    struct Start {
        let hourHeight: CGFloat
        let distance: CGFloat
    }

    /// Fingers count as one above the other when they are at least twice as far apart vertically as horizontally.
    static func isVertical(_ first: CGPoint, _ second: CGPoint) -> Bool {
        abs(first.y - second.y) >= 2 * abs(first.x - second.x)
    }

    var zoom: some Gesture {
        SpatialEventGesture(coordinateSpace: .global)
            .onChanged { events in
                let touches = events.filter { $0.phase == .active }.map(\.location)
                guard touches.count == 2 else {
                    finish()
                    isRejected = touches.count > 2
                    return
                }
                let (first, second) = (touches[0], touches[1])
                let distance = abs(first.y - second.y)
                if start == nil {
                    guard !isRejected, Self.isVertical(first, second), distance > 0 else {
                        isRejected = true
                        return
                    }
                    start = Start(hourHeight: CGFloat(hourHeight), distance: distance)
                    pinchY = (first.y + second.y) / 2
                }
                guard let start else { return }
                hourHeight = Double(CalendarGeometry.clamped(start.hourHeight * distance / start.distance))
            }
            .onEnded { _ in
                finish()
                isRejected = false
            }
    }

    func finish() {
        start = nil
        pinchY = nil
    }
}
