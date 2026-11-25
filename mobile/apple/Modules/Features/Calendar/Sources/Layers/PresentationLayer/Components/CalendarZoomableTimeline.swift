import DesignSystem
import SwiftUI

/// The vertical scroll of one day's timeline at the hour height the person zoomed to. Its content starts below
/// `topInset`, the glass header the day scrolls on under. While a zoom is under way (`pinchY`, the screen height
/// between the fingers), the minute between the fingers stays where it is as the hour height changes, and the
/// fingers do not also scroll the day.
/// How the day scrolls by itself under a held item: how fast, in points a second (down is positive), and what to do
/// after each step, for the held item to follow the day.
struct CalendarAutoScroll {

    var speed: CGFloat
    var onStep: () -> Void
    /// Whether a finger holds an item, which the day does not scroll under by itself.
    var isHolding = false

    static var none: CalendarAutoScroll { CalendarAutoScroll(speed: 0, onStep: {}) }
}

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
    /// The scroll the day makes by itself while an item is held at its edge.
    let autoScroll: CalendarAutoScroll
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
        autoScroll: CalendarAutoScroll,
        @ViewBuilder content: @escaping (CalendarGeometry) -> Content
    ) {
        self.hourHeight = hourHeight
        self.pinchY = pinchY
        self.startId = startId
        self.topInset = topInset
        self.startRequests = startRequests
        self.paper = paper
        self.autoScroll = autoScroll
        self.content = content
        _position = State(initialValue: ScrollPosition(id: startId, anchor: .top))
    }

    // MARK: - State
    @State private var position: ScrollPosition
    /// Where the scroll and the visible part are, kept outside SwiftUI's state: they change with every frame of a
    /// scroll and are read only when a zoom begins.
    @State private var place = Place()
    @State private var anchor: Anchor?
    /// Set once the day was scrolled, after which a new header height (an all-day item gone or come) no longer moves it
    /// to its start.
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
        .scrollDisabled(pinchY != nil || autoScroll.isHolding)
        .onScrollGeometryChange(
            for: Extent.self,
            of: { geometry in
                Extent(
                    offset: geometry.contentOffset.y,
                    low: -geometry.contentInsets.top,
                    high: geometry.contentSize.height - geometry.containerSize.height + geometry.contentInsets.bottom
                )
            },
            action: { _, new in
                place.offset = new.offset
                place.range = new.low...max(new.high, new.low)
            }
        )
        // A held item at the edge carries the day on, a step for every frame, until it is let go or moved away.
        .task(id: autoScroll.speed != 0) {
            guard autoScroll.speed != 0 else { return }
            hasScrolled = true
            var last = ContinuousClock.now
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                let now = ContinuousClock.now
                let seconds = CGFloat((now - last) / .seconds(1))
                last = now
                let step = place.offset + autoScroll.speed * seconds
                let target = min(max(step, place.range.lowerBound), place.range.upperBound)
                // The position counts from the top of the content, which lies below the room kept for the header.
                position.scrollTo(y: target - place.range.lowerBound)
                place.offset = target
                autoScroll.onStep()
            }
        }
        .paperScrollFollowing(paper)
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minY }, action: { place.viewportTop = $0 })
        .onScrollPhaseChange { _, phase in
            // A scroll by a finger, by its momentum or by the day moving itself (an item dragged to the edge) all
            // count: the day stays where it was put when the header changes height afterwards.
            if phase == .interacting || phase == .decelerating || phase == .animating { hasScrolled = true }
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
        /// The least and the greatest offset the scroll can have.
        var range: ClosedRange<CGFloat> = 0...0
    }

    /// Where the scroll is and how far it can go either way.
    struct Extent: Equatable {
        let offset: CGFloat
        let low: CGFloat
        let high: CGFloat
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
