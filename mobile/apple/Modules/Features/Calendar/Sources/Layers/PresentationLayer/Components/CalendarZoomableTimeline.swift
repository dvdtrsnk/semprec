import DesignSystem
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
    /// Each change scrolls the day back to its start, wherever the person scrolled it.
    let startRequests: Int
    /// The paper whose haze this scroll moves, when the day is the one shown.
    let paper: PaperScroll?
    let content: (CalendarGeometry) -> Content

    // MARK: - Init
    /// The day opens at `startId` from its first frame, rather than at its top and moved there once it appears.
    init(
        hourHeight: Double,
        pinchY: CGFloat?,
        startId: String,
        topInset: CGFloat,
        startRequests: Int,
        paper: PaperScroll?,
        @ViewBuilder content: @escaping (CalendarGeometry) -> Content
    ) {
        self.hourHeight = hourHeight
        self.pinchY = pinchY
        self.startId = startId
        self.topInset = topInset
        self.startRequests = startRequests
        self.paper = paper
        self.content = content
        _position = State(initialValue: ScrollPosition(id: startId, anchor: .top))
    }

    // MARK: - State
    @State private var position: ScrollPosition
    /// Where the scroll and the visible part are, kept outside SwiftUI's state: they change with every frame of a
    /// scroll and are read only when a zoom begins.
    @State private var place = Place()
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
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, new in place.offset = new })
        .paperScrollFollowing(paper)
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { place.viewportTop = $0 })
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { hasScrolled = true }
        }
        .onAppear { scrollToStart() }
        // The header is measured after the first page appears; its start then moves below the header.
        .onChange(of: topInset) {
            if !hasScrolled { scrollToStart() }
        }
        .onChange(of: startRequests) {
            withAnimation(.smooth(duration: 0.4)) { scrollToStart() }
        }
        .onChange(of: pinchY == nil) { _, ended in
            guard !ended, let pinchY else {
                anchor = nil
                return
            }
            let viewportY = pinchY - place.viewportTop
            anchor = Anchor(minutes: (place.offset + viewportY) / geometry.hourHeight * 60, viewportY: viewportY)
        }
        .onChange(of: hourHeight) {
            guard let anchor else { return }
            position.scrollTo(y: max(anchor.minutes / 60 * geometry.hourHeight - anchor.viewportY, -topInset))
        }
    }
}

// MARK: - Private
private extension CalendarZoomableTimeline {

    final class Place {
        var offset: CGFloat = 0
        var viewportTop: CGFloat = 0
    }

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
