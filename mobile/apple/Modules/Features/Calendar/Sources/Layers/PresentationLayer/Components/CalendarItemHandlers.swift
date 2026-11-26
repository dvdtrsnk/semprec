import CoreKit
import SwiftUI

/// What the day view does with the gestures of its items; the screen supplies the closures that talk to the shared
/// ViewModel, so the item views stay free of it.
struct CalendarItemHandlers {

    // MARK: - Closures
    let tap: (CalendarItem) -> Void
    /// A finger rested on the item: it is held, selected with its menu.
    let hold: (CalendarItem) -> Void
    /// A finger slides on a selected item, which follows it; the place is in the day view's coordinates.
    let slide: (CalendarItem, DragGesture.Value) -> Void
    /// The sliding finger lifted.
    let slideEnd: () -> Void
    /// What a drag of the item carries.
    let transfer: (CalendarItem) -> CalendarItemTransfer
    /// The system's drag of an item ended, dropped anywhere or not at all.
    let dragEnded: () -> Void
    /// The checkbox of a task, on its own row or in the event `inEventId`.
    let toggle: (_ itemId: String, _ inEventId: String?) -> Void
    let openTask: (_ taskId: String) -> Void
}
