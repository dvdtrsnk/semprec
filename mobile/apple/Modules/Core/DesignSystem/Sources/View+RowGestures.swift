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
    /// the page still scrolls from the row, and one that started sideways keeps the page still to its end. On iOS a
    /// system pan recognizer decides this before it begins (a SwiftUI drag inside a scroll view takes the scroll's
    /// touches too); a macOS window scrolls with the wheel, so a drag there is a SwiftUI drag.
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
    /// A pan that begins only when the finger has gone at least as far sideways as along the page, as SwipeCellKit
    /// decides it for table cells. The scroll view's own pan waits for this one to fail, so a drag that starts
    /// sideways never scrolls the page however it moves afterwards, and one that starts along the page scrolls.
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
            case .began, .changed:
                if recognizer.state == .began { context.coordinator.holdPage(around: recognizer.view) }
                // From where the finger touched down: the pan itself counts only from where it began.
                let start = context.coordinator.touchDown ?? .zero
                let now = recognizer.location(in: nil)
                actions.changed(RowGestureValue(
                    translation: CGSize(width: now.x - start.x, height: now.y - start.y),
                    location: context.converter.location(in: .named(space))
                ))
            case .ended:
                context.coordinator.releasePage()
                actions.ended()
            case .cancelled, .failed:
                context.coordinator.releasePage()
                actions.cancelled()
            default: break
            }
        }
    }

    /// Decides whether a pan is sideways, keeps where its finger touched down, and makes the scroll view around the
    /// row wait for it.
    final class SidewaysDelegate: NSObject, UIGestureRecognizerDelegate {

        /// Where the finger touched down, in window coordinates.
        var touchDown: CGPoint?
        /// The scroll view kept still while the pan goes on.
        private weak var heldPage: UIScrollView?

        /// The page around the row does not scroll until the pan ends, wherever the finger goes.
        func holdPage(around view: UIView?) {
            var ancestor = view?.superview
            while let current = ancestor, !(current is UIScrollView) { ancestor = current.superview }
            heldPage = ancestor as? UIScrollView
            heldPage?.isScrollEnabled = false
        }

        func releasePage() {
            heldPage?.isScrollEnabled = true
            heldPage = nil
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            touchDown = touch.location(in: nil)
            return true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer, let start = touchDown else { return true }
            let now = pan.location(in: nil)
            return abs(now.y - start.y) <= abs(now.x - start.x)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            otherGestureRecognizer.view is UIScrollView && otherGestureRecognizer is UIPanGestureRecognizer
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
