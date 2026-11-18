import SwiftUI

/// The vertical scroll of one day's timeline at the hour height the person zoomed to. While a zoom is under way
/// (`pinchY`, the screen height between the fingers), the minute between the fingers stays where it is as the hour
/// height changes, and the fingers do not also scroll the day.
struct CalendarZoomableTimeline<Content: View>: View {

    // MARK: - Dependencies
    let hourHeight: Double
    /// Where the fingers of a zoom are, in global coordinates; `nil` when no zoom is under way.
    let pinchY: CGFloat?
    /// The minute of the day the timeline opens at, at the top of the visible part.
    let startMinutes: Int
    let content: (CalendarGeometry) -> Content

    // MARK: - State
    @State private var position = ScrollPosition(edge: .top)
    @State private var offset: CGFloat = 0
    @State private var viewportTop: CGFloat = 0
    @State private var anchor: Anchor?

    // MARK: - Body
    var body: some View {
        ScrollView {
            content(geometry)
        }
        .scrollPosition($position)
        .scrollDisabled(pinchY != nil)
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, new in offset = new })
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { viewportTop = $0 })
        .onAppear { position.scrollTo(y: geometry.y(minutes: startMinutes)) }
        .onChange(of: pinchY == nil) { _, ended in
            guard !ended, let pinchY else {
                anchor = nil
                return
            }
            let viewportY = pinchY - viewportTop
            anchor = Anchor(minutes: (offset + viewportY) / geometry.hourHeight * 60, viewportY: viewportY)
        }
        .onChange(of: hourHeight) {
            guard let anchor else { return }
            position.scrollTo(y: max(anchor.minutes / 60 * geometry.hourHeight - anchor.viewportY, 0))
        }
    }
}

// MARK: - Private
private extension CalendarZoomableTimeline {

    /// The minute of the day between the fingers when a zoom began, and its place in the visible part.
    struct Anchor {
        let minutes: CGFloat
        let viewportY: CGFloat
    }

    var geometry: CalendarGeometry { CalendarGeometry(hourHeight: CGFloat(hourHeight)) }
}
