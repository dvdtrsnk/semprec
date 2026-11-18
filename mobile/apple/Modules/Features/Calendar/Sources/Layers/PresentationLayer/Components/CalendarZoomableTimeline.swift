import SwiftUI

/// The vertical scroll of one day's timeline, which two fingers zoom: pinching apart makes every hour, and every item
/// on it, taller, pinching together fits more of the day on the screen. The minute between the fingers stays where
/// it is while the scale changes. The hour height is shared, so every day keeps the scale the person chose.
struct CalendarZoomableTimeline<Content: View>: View {

    // MARK: - Dependencies
    @Binding var hourHeight: Double
    /// The minute of the day the timeline opens at, at the top of the visible part.
    let startMinutes: Int
    let content: (CalendarGeometry) -> Content

    // MARK: - State
    @State private var position = ScrollPosition(edge: .top)
    @State private var offset: CGFloat = 0
    @State private var pinch: Pinch?

    // MARK: - Body
    var body: some View {
        ScrollView {
            content(CalendarGeometry(hourHeight: CGFloat(hourHeight)))
        }
        .scrollPosition($position)
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, new in offset = new })
        .simultaneousGesture(zoom)
        .onAppear {
            position.scrollTo(y: CalendarGeometry(hourHeight: CGFloat(hourHeight)).y(minutes: startMinutes))
        }
    }
}

// MARK: - Private
private extension CalendarZoomableTimeline {

    /// Where a pinch began: the hour height then, and the minute of the day under the fingers with its place in the
    /// visible part of the timeline.
    struct Pinch {
        let startHourHeight: CGFloat
        let minutes: CGFloat
        let viewportY: CGFloat
    }

    var zoom: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = pinch ?? Pinch(
                    startHourHeight: CGFloat(hourHeight),
                    minutes: (offset + value.startLocation.y) / CGFloat(hourHeight) * 60,
                    viewportY: value.startLocation.y
                )
                pinch = start
                let height = CalendarGeometry.clamped(start.startHourHeight * value.magnification)
                guard Double(height) != hourHeight else { return }
                hourHeight = Double(height)
                position.scrollTo(y: max(start.minutes / 60 * height - start.viewportY, 0))
            }
            .onEnded { _ in pinch = nil }
    }
}
