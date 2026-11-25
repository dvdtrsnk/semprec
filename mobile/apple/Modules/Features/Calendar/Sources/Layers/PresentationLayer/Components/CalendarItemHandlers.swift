import CoreKit
import SwiftUI

/// What the day view does with the gestures of its items; the screen supplies the closures that talk to the shared
/// ViewModel, so the item views stay free of it.
struct CalendarItemHandlers {

    // MARK: - Closures
    let tap: (CalendarItem) -> Void
    /// A long press holds the item; the day view takes its movement from there.
    let hold: (CalendarItem) -> Void
    let toggle: (_ itemId: String) -> Void
    let openTask: (_ taskId: String) -> Void
}
