import SwiftUI

/// Moves `content` with the shown day's timeline as it scrolls, `base` below its top. Only this view redraws while
/// the day moves; `content` is built by its holder and stays as it is.
struct CalendarTimelineFollower<Content: View>: View {

    // MARK: - Dependencies
    let frames: CalendarDayFrames
    let base: CGFloat
    let content: Content

    // MARK: - Body
    var body: some View {
        content.offset(y: base + frames.contentTop)
    }
}
