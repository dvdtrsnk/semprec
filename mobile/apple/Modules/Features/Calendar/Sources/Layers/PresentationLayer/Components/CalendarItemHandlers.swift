import CoreKit
import SwiftUI

/// What the day view does with the gestures of its items; the screen supplies the closures that talk to the shared
/// ViewModel, so the item views stay free of it.
struct CalendarItemHandlers {

    // MARK: - Closures
    let tap: (CalendarItem) -> Void
    let select: (CalendarItem) -> Void
    /// The finger moved while an item is held: `location` and `start` are in the day view's space.
    let move: (_ item: CalendarItem, _ location: CGPoint, _ start: CGPoint) -> Void
    let end: (_ item: CalendarItem, _ moved: Bool) -> Void
    let toggle: (_ itemId: String) -> Void
    let openTask: (_ taskId: String) -> Void
}
