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
    /// Where the finger of a drag over the day is, as the day view last handled it, and as the system last reported
    /// it with the content under it then.
    @ObservationIgnored var dropLocation: CGPoint?
    @ObservationIgnored var reportedLocation: CGPoint?
    @ObservationIgnored var dropContentTop: CGFloat = 0
    /// Where the finger carrying an item is, and the move last told to the shared layer.
    @ObservationIgnored var carryLocation: CGPoint?
    @ObservationIgnored var sentMove: CalendarSentMove?
    /// The top of the content.
    private(set) var contentTop: CGFloat = 0

    // MARK: - Methods
    func update(content frame: CGRect) {
        content = frame
        if frame.minY != contentTop { contentTop = frame.minY }
    }
}

/// A move of a carried item as the shared layer is told it: the day, the quarter hour, the all-day row and the event
/// under the finger.
struct CalendarSentMove: Equatable {

    let day: String
    let quarter: Int
    let overAllDayRow: Bool
    let overEventId: String?
}
