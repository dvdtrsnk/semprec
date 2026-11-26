import CoreKit
import SwiftUI

/// The coordinate space of the whole day view, in which every gesture of an item reports where the finger is.
extension CoordinateSpaceProtocol where Self == NamedCoordinateSpace {

    static var calendarDay: NamedCoordinateSpace { .named("calendarDay") }
}

/// What a finger does on one item. A tap opens it. Held, an event or a task lifts into the system's drag, which holds
/// it, which the day view receives as its drop target, and which can also carry the item to another app, while other
/// fingers go on using the calendar; nothing here may claim the touch before it lifts, or the system never lifts it.
/// On iOS the drag is the day view's `CalendarDragSource`; on macOS the item is SwiftUI's draggable. A selected item
/// also follows a finger that slides on it straight away, as the system Calendar's selected event does.
struct CalendarItemGestures: ViewModifier {

    // MARK: - Constants
    /// How far a finger slides on a selected item before it moves it, rather than leaving the touch to a tap or a lift.
    private static let slideDistance: CGFloat = 6

    // MARK: - Dependencies
    let item: CalendarItem
    /// Whether the item can be moved; one that cannot still travels to other apps.
    let enabled: Bool
    let selected: Bool
    let handlers: CalendarItemHandlers

    // MARK: - Body
    func body(content: Content) -> some View {
        let tappable = content
            .contentShape(Rectangle())
            .onTapGesture { handlers.tap(item) }
            .gesture(
                DragGesture(minimumDistance: Self.slideDistance, coordinateSpace: .calendarDay)
                    .onChanged { handlers.slide(item, $0) }
                    .onEnded { _ in handlers.slideEnd() },
                isEnabled: enabled && selected
            )
        #if os(iOS)
        tappable
        #else
        if item.kind == .event || item.kind == .task {
            tappable
                .onLongPressGesture(minimumDuration: 0.35) { if enabled, !selected { handlers.hold(item) } }
                .draggable(handlers.transfer(item)) { CalendarDragPreview(item: item) }
                .modifier(CalendarDragConfiguration(onEnd: handlers.dragEnded))
        } else {
            tappable
        }
        #endif
    }
}

#if os(macOS)
/// Lets a drag move its item within the app and copy it to another app, and tells when the drag ended.
private struct CalendarDragConfiguration: ViewModifier {

    let onEnd: () -> Void

    func body(content: Content) -> some View {
        content
            .dragConfiguration(DragConfiguration(allowMove: true))
            .onDragSessionUpdated { session in
                if case .ended = session.phase { onEnd() }
            }
    }
}
#endif

// MARK: - View
extension View {

    /// Makes the view an item of the calendar: a tap, a lift into a drag, and a slide while it is selected.
    func calendarItemGestures(
        _ item: CalendarItem,
        enabled: Bool,
        selected: Bool,
        handlers: CalendarItemHandlers
    ) -> some View {
        modifier(CalendarItemGestures(item: item, enabled: enabled, selected: selected, handlers: handlers))
    }
}
