import SwiftUI

/// Where the shown day's timeline is in the day view. Gestures read the frames when they need them, outside SwiftUI's
/// state, so a scroll does not redraw the day view; only a view that follows `contentTop` redraws as the day moves.
@MainActor
@Observable
final class CalendarDayFrames {

    // MARK: - Properties
    /// The timeline's content, which moves as the day scrolls.
    @ObservationIgnored var content = CGRect.zero
    /// The visible part of the timeline.
    @ObservationIgnored var viewport = CGRect.zero
    /// The top of the content.
    private(set) var contentTop: CGFloat = 0

    // MARK: - Methods
    func update(content frame: CGRect) {
        content = frame
        if frame.minY != contentTop { contentTop = frame.minY }
    }
}
