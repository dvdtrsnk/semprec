import SwiftUI
import Synchronization

/// What the paging behaviour needs to know of the scroll as it happens: whether a finger drags it, and where it is.
/// The scroll view asks for its target outside the main actor, so the values sit behind a lock.
final class CalendarPagerTracker: Sendable {

    // MARK: - Properties
    private let state = Mutex(State())

    var isDragging: Bool {
        get { state.withLock { $0.isDragging } }
        set { state.withLock { $0.isDragging = newValue } }
    }

    var offset: CGFloat {
        get { state.withLock { $0.offset } }
        set { state.withLock { $0.offset = newValue } }
    }

    /// Ends the drag the first time a lift is decided and tells whether this call was that first time.
    func takeDrag() -> Bool {
        state.withLock { current in
            defer { current.isDragging = false }
            return current.isDragging
        }
    }
}

// MARK: - Private
private extension CalendarPagerTracker {

    struct State {
        var isDragging = false
        var offset: CGFloat = 0
    }
}
