import SwiftUI

/// What a row gesture reports: how far the finger went from where it started and where it is, in the named
/// coordinate space the gesture was given.
public struct RowGestureValue: Equatable, Sendable {

    public var translation: CGSize
    public var location: CGPoint
}

/// What a row gesture does as it goes: `changed` while the finger moves, then `ended` when it lifts or `cancelled`
/// when the system takes the touch away.
public struct RowGestureActions {

    let changed: @MainActor (RowGestureValue) -> Void
    let ended: @MainActor () -> Void
    let cancelled: @MainActor () -> Void

    public init(
        changed: @escaping @MainActor (RowGestureValue) -> Void,
        ended: @escaping @MainActor () -> Void,
        cancelled: @escaping @MainActor () -> Void
    ) {
        self.changed = changed
        self.ended = ended
        self.cancelled = cancelled
    }
}

// MARK: - Row gestures
extension View {

    /// A drag that starts sideways. A drag that starts along the page is left to the scroll view around the row, so
    /// the page still scrolls from the row. On iOS a system pan recognizer decides this before it begins (a SwiftUI
    /// drag inside a scroll view takes the scroll's touches too); a macOS window scrolls with the wheel, so a drag
    /// there is a SwiftUI drag.
    public func sidewaysDrag(in space: String, isEnabled: Bool = true, _ actions: RowGestureActions) -> some View {
        #if os(iOS)
            gesture(SidewaysPan(space: space, isEnabled: isEnabled, actions: actions))
        #else
            simultaneousGesture(
                DragGesture(minimumDistance: 12, coordinateSpace: .named(space))
                    .onChanged { actions.changed(RowGestureValue(translation: $0.translation, location: $0.location)) }
                    .onEnded { _ in actions.ended() },
                isEnabled: isEnabled
            )
        #endif
    }

    /// A finger held still on the row for `duration`, then moved or lifted. `began` comes when the hold is long
    /// enough; `changed` reports the finger from where the hold began.
    public func holdAndDrag(
        in space: String,
        duration: Double = 0.4,
        isEnabled: Bool = true,
        began: @escaping @MainActor () -> Void,
        _ actions: RowGestureActions
    ) -> some View {
        #if os(iOS)
            gesture(
                HoldPress(space: space, duration: duration, isEnabled: isEnabled, began: began, actions: actions)
            )
        #else
            simultaneousGesture(
                LongPressGesture(minimumDuration: duration)
                    .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named(space)))
                    .onChanged { value in
                        guard case .second(true, let drag) = value else { return }
                        if let drag {
                            actions.changed(RowGestureValue(translation: drag.translation, location: drag.location))
                        } else {
                            began()
                        }
                    }
                    .onEnded { value in if case .second(true, _) = value { actions.ended() } },
                isEnabled: isEnabled
            )
        #endif
    }
}

#if os(iOS)
    /// A pan that begins only when the finger first moves more sideways than along the page.
    private struct SidewaysPan: UIGestureRecognizerRepresentable {

        let space: String
        let isEnabled: Bool
        let actions: RowGestureActions

        func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
            let pan = UIPanGestureRecognizer()
            pan.delegate = context.coordinator
            return pan
        }

        func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
            recognizer.isEnabled = isEnabled
        }

        func makeCoordinator(converter: CoordinateSpaceConverter) -> SidewaysDelegate {
            SidewaysDelegate()
        }

        func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
            switch recognizer.state {
            case .began:
                stopScrolling(around: recognizer.view)
                report(recognizer, context: context)
            case .changed:
                report(recognizer, context: context)
            case .ended: actions.ended()
            case .cancelled, .failed: actions.cancelled()
            default: break
            }
        }

        func report(_ recognizer: UIPanGestureRecognizer, context: Context) {
            let translation = recognizer.translation(in: recognizer.view)
            actions.changed(RowGestureValue(
                translation: CGSize(width: translation.x, height: translation.y),
                location: context.converter.location(in: .named(space))
            ))
        }

        /// The scroll view around the row lets go of this touch, so the page stays still under a sideways drag.
        func stopScrolling(around view: UIView?) {
            var ancestor = view?.superview
            while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
            guard let scroll = ancestor as? UIScrollView else { return }
            scroll.panGestureRecognizer.isEnabled = false
            scroll.panGestureRecognizer.isEnabled = true
        }
    }

    /// Lets a pan begin only when it starts clearly sideways, alongside the scroll view's own pan, which would
    /// otherwise take every drag first.
    final class SidewaysDelegate: NSObject, UIGestureRecognizerDelegate {

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            otherGestureRecognizer.view is UIScrollView
        }
    }

    /// A long press that follows the finger after it began.
    private struct HoldPress: UIGestureRecognizerRepresentable {

        let space: String
        let duration: Double
        let isEnabled: Bool
        let began: @MainActor () -> Void
        let actions: RowGestureActions

        func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
            let press = UILongPressGestureRecognizer()
            press.minimumPressDuration = duration
            return press
        }

        func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
            recognizer.isEnabled = isEnabled
        }

        func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
            switch recognizer.state {
            case .began:
                began()
            case .changed:
                actions.changed(RowGestureValue(
                    translation: .zero,
                    location: context.converter.location(in: .named(space))
                ))
            case .ended: actions.ended()
            case .cancelled, .failed: actions.cancelled()
            default: break
            }
        }
    }
#endif
