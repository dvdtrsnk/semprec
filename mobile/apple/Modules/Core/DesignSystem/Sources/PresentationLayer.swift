import SwiftUI

// MARK: - Layer
/// The presentation a view is on: the scene's own content or one of the sheets, covers and popovers stacked over it.
/// The Semp bubble floats over all of them on iOS, so an object it is dragged over counts only when it is on the
/// presentation that is on top at the finger. SwiftUI tells a view neither which presentation it is on nor which one
/// is on top at a point, so on iOS a view's layer is read from the UIKit view controller that hosts it, and on macOS,
/// where the bubble of each sheet only sees the objects of that sheet, a view has no layer.
@MainActor
public final class PresentationLayer {

    // MARK: - Properties
    #if os(iOS)
    fileprivate weak var anchor: UIView?
    #endif
    private var read: (@MainActor () -> AnyObject?)?

    // MARK: - Init
    /// The layer of the view `presentationLayer(_:)` is applied to.
    public init() {}

    /// A layer that is always on `presentation`, for tests of what reads layers.
    init(reading presentation: @escaping @MainActor () -> AnyObject?) {
        read = presentation
    }

    // MARK: - Methods
    /// The root controller of the presentation the view is on, compared by identity; nil when it is not in a window.
    public var presentation: AnyObject? {
        if let read { return read() }
        #if os(iOS)
        return anchor.flatMap(Self.presentation(of:))
        #else
        return nil
        #endif
    }

    #if os(iOS)
    /// The root controller of the presentation that is on top at `point` of `window`, in the window's coordinates.
    public static func presentation(at point: CGPoint, in window: UIWindow) -> AnyObject? {
        window.hitTest(point, with: nil).flatMap(presentation(of:))
    }

    /// The root controller of the presentation `view` is on: the first controller up its responder chain, and the
    /// controller that contains that one, up to the one no other controller contains.
    static func presentation(of view: UIView) -> UIViewController? {
        var responder: UIResponder? = view
        while let next = responder, !(next is UIViewController) { responder = next.next }
        guard var controller = responder as? UIViewController else { return nil }
        while let parent = controller.parent { controller = parent }
        return controller
    }
    #endif
}

// MARK: - Anchor
extension View {

    /// Lets `layer` find the presentation this view is on.
    func presentationLayer(_ layer: PresentationLayer) -> some View {
        #if os(iOS)
        background(PresentationAnchor(layer: layer))
        #else
        self
        #endif
    }
}

#if os(iOS)
/// An invisible view that takes no touches, behind the view whose presentation `layer` reads.
private struct PresentationAnchor: UIViewRepresentable {

    let layer: PresentationLayer

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        layer.anchor = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        layer.anchor = view
    }
}
#endif
