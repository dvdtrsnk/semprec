import CoreKit

/// What the diary's page shows while its axis moves or its page turns. While the axis moves, the page keeps the state
/// it had when the axis started to (`held`): the cards of a new selection are built once the axis comes to rest, so
/// building them never takes a frame from the axis's scroll. A turn of the page shows the new period as soon as it
/// comes, the axis moving or not, since the page that leaves is out of view: while `isTurning`, nothing is held.
struct JournalPageHold: Equatable {

    private(set) var held: JournalState?
    private(set) var isTurning = false

    /// A turn of the page started: the page shows the diary's state from now on.
    mutating func turnStarted() {
        isTurning = true
        held = nil
    }

    /// The axis started (`moving`) or stopped moving. Starting, it holds `state` unless a turn is under way or
    /// something is held already; at rest, it holds nothing and the turn is over.
    mutating func axisMoved(_ moving: Bool, showing state: JournalState) {
        if moving {
            if !isTurning, held == nil { held = state }
        } else {
            held = nil
            isTurning = false
        }
    }

    /// The period a turn went to is shown. With the axis at rest the turn is over; with the axis still moving to it,
    /// the turn ends when the axis rests (`axisMoved(false, …)`).
    mutating func periodShown(axisMoving: Bool) {
        if !axisMoving { isTurning = false }
    }
}
