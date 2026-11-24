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
    /// True while a finger holds the item after the long press; it falls back to false when the finger lifts and
    /// also when the system takes the touch away (a scroll, a call), which gives `onEnded` no call.
    @GestureState private var isHeld = false
    /// Set from the long press until just after the finger lifts, so that the lift does not also count as a tap.
    @State private var isAfterPress = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .onTapGesture { if !isAfterPress { onTap() } }
            .gesture(moveGesture, isEnabled: enabled)
            .onChange(of: isHeld) { _, held in
                // A touch the system took away leaves the shared state dragging; end it without writing anything.
                if !held, selected {
                    selected = false
                    moved = false
                    onEnd(false)
                }
                if !held { releasePress() }
            }
    }
}

// MARK: - Gesture
private extension CalendarItemGestures {

    var moveGesture: some Gesture {
        LongPressGesture(minimumDuration: Self.pressDuration)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .calendarDay))
            .updating($isHeld) { value, held, _ in
                if case .second = value { held = true }
            }
            .onChanged { value in
                switch value {
                case .first:
                    break
                case .second(_, let drag):
                    if !selected {
                        selected = true
                        isAfterPress = true
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
                releasePress()
            }
    }

    /// The tap of the lift comes with the end of the press; the flag goes a moment after it, not before.
    func releasePress() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            isAfterPress = false
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
