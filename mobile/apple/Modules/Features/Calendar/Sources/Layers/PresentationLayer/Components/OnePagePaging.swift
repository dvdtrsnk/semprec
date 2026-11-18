import SwiftUI

/// Paging that settles at most one page away from where the swipe started: the page the swipe would come to rest
/// on, rounded, and clamped to the neighbouring pages. So a slow drag past half a page turns it, a shorter one
/// springs back, and a fast flick turns exactly one page however fast it is. A scroll the view makes itself has
/// no velocity and may travel further.
struct OnePagePaging: ScrollTargetBehavior {

    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        let width = context.containerSize.width
        guard width > 0 else { return }
        let start = (context.originalTarget.rect.minX / width).rounded()
        let proposed = target.rect.minX / width
        let isProgrammatic = context.velocity == .zero && abs(proposed - start) > 1.5
        let page = isProgrammatic ? proposed.rounded() : start + min(max((proposed - start).rounded(), -1), 1)
        target.rect.origin.x = page * width
    }
}
