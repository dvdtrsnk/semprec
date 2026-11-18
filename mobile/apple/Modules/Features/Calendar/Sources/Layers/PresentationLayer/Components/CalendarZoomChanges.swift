import CoreKit
import SwiftUI

/// The change of zoom under way. The views' transitions read it as they come in or go out, so a view leaves with
/// the change that removes it, not the one that brought it.
@MainActor
final class CalendarZoomChanges {

    var current: CalendarZoomTransition?

    /// How the view of `zoom` comes in and goes out.
    func transition(for zoom: CalendarZoom) -> some Transition {
        CalendarZoomViewTransition(zoom: zoom, changes: self)
    }
}

/// The transition of one view of the calendar, which takes its look from the change under way when it runs.
private struct CalendarZoomViewTransition: Transition {

    let zoom: CalendarZoom
    let changes: CalendarZoomChanges

    func body(content: Content, phase: TransitionPhase) -> some View {
        let effect = changes.current?.effect(for: zoom) ?? CalendarZoomEffect()
        return content.modifier(phase.isIdentity ? effect.shown : effect)
    }
}
