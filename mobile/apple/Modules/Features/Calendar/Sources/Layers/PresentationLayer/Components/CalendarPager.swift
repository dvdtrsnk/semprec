import SwiftUI

/// Pages side by side, the current one in view, that follow a horizontal drag of the finger. The moment the finger
/// lifts decides the turn: past half the width, or a short fast flick, turns to the neighbouring page and never
/// further; anything less springs back. `onTurn` is called right then; the scroll stops coasting and the page slides
/// into place in a short animation of its own. A `current` set from outside slides in from its side. Being a scroll
/// view, a drag sideways cancels the taps and presses of what the finger started on.
struct CalendarPager<Page: View>: View {

    // MARK: - Dependencies
    let current: String
    /// The key `steps` pages away from `key`.
    let neighbour: (_ key: String, _ steps: Int) -> String
    let isEnabled: Bool
    let onTurn: (_ steps: Int) -> Void
    @ViewBuilder let page: (String) -> Page

    // MARK: - State
    /// The key the pages are laid out around; moved when the pager nears either end.
    @State private var anchor: String?
    /// The pages around the anchor, worked out again only when the anchor moves.
    @State private var cache = CalendarKeyCache()
    @State private var position = ScrollPosition(idType: String.self)
    /// The page a turn decided on, until `current` arrives at it.
    @State private var turnedTo: String?
    @State private var tracker = CalendarPagerTracker()
    @State private var pageWidth: CGFloat = 0
    /// Set while a finger's drag has not been decided yet; only such a drag may turn the page when the scroll rests.
    @State private var isUndecidedDrag = false

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(keys, id: \.self) { key in
                    page(key)
                        .containerRelativeFrame(.horizontal)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(OnePagePaging(tracker: tracker) { decide(page: $0) })
        .scrollIndicators(.hidden)
        .scrollPosition($position)
        .scrollDisabled(!isEnabled)
        .onScrollPhaseChange { _, phase in
            if phase == .interacting {
                tracker.isDragging = true
                isUndecidedDrag = true
            }
            if phase == .idle {
                tracker.isDragging = false
                settleOnRest()
            }
        }
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.x }, action: { _, new in
            tracker.offset = new
        })
        .onScrollGeometryChange(for: CGFloat.self, of: { $0.containerSize.width }, action: { _, new in
            pageWidth = new
        })
        .onAppear {
            anchor = current
            position.scrollTo(id: current)
        }
        .onChange(of: current) { _, new in
            if new == turnedTo {
                turnedTo = nil
                return
            }
            turnedTo = nil
            isUndecidedDrag = false
            recenterIfNeeded(on: new)
            withAnimation(Self.slide) { position.scrollTo(id: new) }
        }
    }
}

// MARK: - Private
private extension CalendarPager {

    static var slide: Animation { .easeOut(duration: 0.18) }
    /// Pages on each side of the anchor; the pager recenters before a swipe can reach the last one.
    static var pagesAround: Int { 30 }

    var keys: [String] {
        cache.keys(around: anchor ?? current) { center in
            (-Self.pagesAround...Self.pagesAround).map { neighbour(center, $0) }
        }
    }

    /// The finger lifted and the turn settles on `page`, counted from the first laid-out page.
    func decide(page index: Int) {
        isUndecidedDrag = false
        let keys = keys
        guard keys.indices.contains(index) else { return }
        let target = keys[index]
        let base = turnedTo ?? current
        if target != base, let from = keys.firstIndex(of: base) {
            turnedTo = target
            onTurn(index - from)
        }
        withAnimation(Self.slide) { position.scrollTo(id: target) }
        recenterIfNeeded(on: target)
    }

    /// When the scroll comes to rest: an undecided drag that left another page in view turns to it; otherwise a
    /// scroll that stopped off the chosen page, cut short by another, slides back onto it.
    func settleOnRest() {
        defer { isUndecidedDrag = false }
        let keys = keys
        guard pageWidth > 0 else { return }
        let index = Int((tracker.offset / pageWidth).rounded())
        let base = turnedTo ?? current
        guard keys.indices.contains(index), let from = keys.firstIndex(of: base) else { return }
        if isUndecidedDrag, index != from {
            let resting = keys[index]
            turnedTo = resting
            onTurn(index - from)
            recenterIfNeeded(on: resting)
            withAnimation(Self.slide) { position.scrollTo(id: resting) }
        } else if abs(tracker.offset - CGFloat(from) * pageWidth) > 0.5 {
            withAnimation(Self.slide) { position.scrollTo(id: base) }
        }
    }

    func recenterIfNeeded(on key: String) {
        guard let index = keys.firstIndex(of: key) else {
            anchor = key
            return
        }
        if abs(index - Self.pagesAround) > Self.pagesAround - 8 { anchor = key }
    }
}

/// Paging that settles at most one page away from where the swipe started: the page the swipe would come to rest
/// on, rounded, and clamped to the neighbouring pages. When a finger lifts, the scroll stops where it is and the page
/// is reported at once, for the pager to slide to; a scroll the pager makes itself settles on its page as usual.
private struct OnePagePaging: ScrollTargetBehavior {

    let tracker: CalendarPagerTracker
    let onTarget: @MainActor @Sendable (Int) -> Void

    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        let width = context.containerSize.width
        guard width > 0 else { return }
        let start = (context.originalTarget.rect.minX / width).rounded()
        let proposed = target.rect.minX / width
        let isProgrammatic = context.velocity == .zero && abs(proposed - start) > 1.5
        let page = isProgrammatic ? proposed.rounded() : start + min(max((proposed - start).rounded(), -1), 1)
        target.rect.origin.x = page * width
        // The scroll also asks as a drag begins, before anything moved; only a lift decides.
        let hasMoved = context.velocity != .zero || proposed != start
        guard hasMoved, tracker.takeDrag() else { return }
        let report = onTarget
        Task { @MainActor in report(Int(page)) }
    }
}
