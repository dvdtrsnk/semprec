import SwiftUI

/// The vertical scroll of one day's timeline at the hour height the person zoomed to. Its content starts below
/// `topInset`, the glass header the day scrolls on under. While a zoom is under way (`pinchY`, the screen height
/// between the fingers), the minute between the fingers stays where it is as the hour height changes, and the
/// fingers do not also scroll the day.
struct CalendarZoomableTimeline<Content: View>: View {

    // MARK: - Dependencies
    let hourHeight: Double
    /// Where the fingers of a zoom are, in global coordinates; `nil` when no zoom is under way.
    let pinchY: CGFloat?
    /// The identity of the hour row the timeline opens at, just below the header.
    let startId: String
    /// The height of the header over the top of the scroll.
    let topInset: CGFloat
    let content: (CalendarGeometry) -> Content

    // MARK: - State
    @State private var position = ScrollPosition(edge: .top)
    @State private var offset: CGFloat = 0
    @State private var viewportTop: CGFloat = 0
    @State private var anchor: Anchor?
    /// Set once the person scrolled the day, after which a new header height no longer moves it to its start.
    @State private var hasScrolled = false

    // MARK: - Body
    var body: some View {
        ScrollView {
            content(geometry)
        }
        // A little room above the first hour, whose label sits above its line.
        .contentMargins(.top, topInset + 10, for: .scrollContent)
        // The glass header is the edge; the scroll draws no fade of its own under it.
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollPosition($position)
        .scrollDisabled(pinchY != nil)
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, new in offset = new })
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { viewportTop = $0 })
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { hasScrolled = true }
        }
        .onAppear { scrollToStart() }
        // The header is measured after the first page appears; its start then moves below the header.
        .onChange(of: topInset) {
            if !hasScrolled { scrollToStart() }
        }
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
            position.scrollTo(y: max(anchor.minutes / 60 * geometry.hourHeight - anchor.viewportY, -topInset))
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

    /// Puts the start hour just below the header.
    func scrollToStart() {
        position.scrollTo(id: startId, anchor: .top)
    }
}
