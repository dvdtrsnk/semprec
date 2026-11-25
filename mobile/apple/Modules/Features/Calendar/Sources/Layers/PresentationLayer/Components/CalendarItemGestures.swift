import SwiftUI

/// The coordinate space of the whole day view, in which every gesture of an item reports where the finger is.
extension CoordinateSpaceProtocol where Self == NamedCoordinateSpace {

    static var calendarDay: NamedCoordinateSpace { .named("calendarDay") }
}

/// What a finger does on one item: a tap opens it, and a long press holds it. What a held item then does with the
/// finger, being moved, is the day view's: the item's own view can leave the screen while it is carried to another
/// day, and a gesture that belonged to it would end with it.
struct CalendarItemGestures: ViewModifier {

    // MARK: - Constants
    private static let pressDuration = 0.35

    // MARK: - Dependencies
    let enabled: Bool
    let onTap: () -> Void
    let onHold: () -> Void

    // MARK: - State
    /// Set from the long press until just after the finger lifts, so that the lift does not also count as a tap.
    @State private var isAfterPress = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .onTapGesture { if !isAfterPress { onTap() } }
            .gesture(
                LongPressGesture(minimumDuration: Self.pressDuration).onEnded { _ in
                    isAfterPress = true
                    onHold()
                },
                isEnabled: enabled
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 0).onEnded { _ in
                    guard isAfterPress else { return }
                    // The tap of the lift comes with the end of the touch; the flag goes a moment after it.
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(300))
                        isAfterPress = false
                    }
                }
            )
    }
}

// MARK: - View
extension View {

    /// Makes the view an item of the calendar: a tap, and a long press that holds it.
    func calendarItemGestures(enabled: Bool, onTap: @escaping () -> Void, onHold: @escaping () -> Void) -> some View {
        modifier(CalendarItemGestures(enabled: enabled, onTap: onTap, onHold: onHold))
    }
}
