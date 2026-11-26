#if os(iOS)
import SwiftUI

/// The two fingers of a zoom on iOS, read by a pinch recognizer on the view that holds the day: it begins only with
/// two touches, so a single finger scrolls the day, turns it or lifts an item as if it were not there. SwiftUI has no
/// gesture that waits for a second touch, which is why this one is UIKit's. Places are global, as SwiftUI's.
struct CalendarPinchSource: UIViewRepresentable {

    // MARK: - Dependencies
    /// The places of the fingers, as they move.
    let onChange: ([CGPoint]) -> Void
    let onEnd: () -> Void

    // MARK: - UIViewRepresentable
    func makeCoordinator() -> Coordinator { Coordinator(source: self) }

    func makeUIView(context: Context) -> CalendarHostAttachment {
        let recognizer = UIPinchGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.pinched(_:))
        )
        recognizer.delegate = context.coordinator
        recognizer.cancelsTouchesInView = false
        return CalendarHostAttachment { host in
            host.addGestureRecognizer(recognizer)
            return { host.removeGestureRecognizer(recognizer) }
        }
    }

    func updateUIView(_ view: CalendarHostAttachment, context: Context) {
        context.coordinator.source = self
    }

    // MARK: - Coordinator
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {

        var source: CalendarPinchSource

        init(source: CalendarPinchSource) {
            self.source = source
        }

        @objc
        func pinched(_ recognizer: UIPinchGestureRecognizer) {
            switch recognizer.state {
            case .began, .changed:
                let touches = (0..<recognizer.numberOfTouches).map { recognizer.location(ofTouch: $0, in: nil) }
                source.onChange(touches)
            default:
                source.onEnd()
            }
        }

        /// The day scrolls and its items lift as before while two fingers rest on it.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// A view that takes no touches and, while it is in a window, attaches something to the root view of the controller
/// that shows it, where the touches of everything around it arrive; `attach` returns how to take it off again.
final class CalendarHostAttachment: UIView {

    private let attach: (UIView) -> () -> Void
    private var detach: (() -> Void)?

    init(attach: @escaping (UIView) -> () -> Void) {
        self.attach = attach
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        detach?()
        detach = nil
        guard window != nil else { return }
        var view: UIView? = superview
        while let candidate = view, !(candidate.next is UIViewController) { view = candidate.superview }
        if let host = view ?? superview { detach = attach(host) }
    }
}
#endif
