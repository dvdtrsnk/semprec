import SwiftUI

/// The coordinate space of the whole day view, in which every gesture of an item reports where the finger is.
extension CoordinateSpaceProtocol where Self == NamedCoordinateSpace {

    static var calendarDay: NamedCoordinateSpace { .named("calendarDay") }
}

/// What a finger does on one item: a tap opens it, a long press selects it, and a drag after the long press moves
/// it. Positions are in the day view's space; the day view turns them into minutes.
struct CalendarItemGestures: ViewModifier {

    // MARK: - Constants
    private static let pressDuration = 0.35
    /// How far the finger has to travel before a long press counts as a move rather than a selection.
    private static let moveThreshold: CGFloat = 4

    // MARK: - Dependencies
    let enabled: Bool
    let onTap: () -> Void
    let onSelect: () -> Void
    let onMove: (_ location: CGPoint, _ start: CGPoint) -> Void
    let onEnd: (_ moved: Bool) -> Void

    // MARK: - State
    @State private var selected = false
    @State private var moved = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .onTapGesture(perform: onTap)
            .gesture(moveGesture, isEnabled: enabled)
    }
}

// MARK: - Gesture
private extension CalendarItemGestures {

    var moveGesture: some Gesture {
        LongPressGesture(minimumDuration: Self.pressDuration)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .calendarDay))
            .onChanged { value in
                switch value {
                case .first:
                    break
                case .second(_, let drag):
                    if !selected {
                        selected = true
                        onSelect()
                    }
                    guard let drag else { return }
                    let travelled = hypot(
                        drag.location.x - drag.startLocation.x,
                        drag.location.y - drag.startLocation.y
                    )
                    if moved || travelled >= Self.moveThreshold {
                        moved = true
                        onMove(drag.location, drag.startLocation)
                    }
                }
            }
            .onEnded { value in
                if case .second = value { onEnd(moved) }
                selected = false
                moved = false
            }
    }
}

// MARK: - View
extension View {

    /// Makes the view an item of the calendar: tap, long press to select, drag after the long press to move.
    func calendarItemGestures(
        enabled: Bool,
        onTap: @escaping () -> Void,
        onSelect: @escaping () -> Void,
        onMove: @escaping (_ location: CGPoint, _ start: CGPoint) -> Void,
        onEnd: @escaping (_ moved: Bool) -> Void
    ) -> some View {
        modifier(
            CalendarItemGestures(enabled: enabled, onTap: onTap, onSelect: onSelect, onMove: onMove, onEnd: onEnd)
        )
    }
}
