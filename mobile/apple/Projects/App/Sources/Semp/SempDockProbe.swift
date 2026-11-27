#if os(iOS)
import DesignSystem
import SwiftUI

/// Reads, on iOS, whether Semp's button in the tab bar is shown and on top, for `SempDock`. SwiftUI says neither
/// where a tab is drawn nor whether the tab bar is hidden or covered, and UIKit announces none of the presentations
/// that cover it, so the probe looks at the window's `UITabBarController` itself, ten times a second while the
/// window is on screen: the frame of the button the system draws apart from the other tabs at the trailing end of the
/// bar, and whether a touch at its middle reaches the tab bar (it does not while the bar is hidden or anything is
/// presented over it). The same hit test tells `dropTargets` which presentation is on top at a point. The probe sits
/// behind the scene's content, which stays in the window under every push and sheet, and leaves the window under a
/// full-screen cover, where the bubble floats.
struct SempDockProbe: UIViewRepresentable {

    // MARK: - Dependencies
    let dock: SempDock
    let dropTargets: DropTargetRegistry

    // MARK: - UIViewRepresentable
    func makeUIView(context: Context) -> SempDockProbeView {
        SempDockProbeView(dock: dock, dropTargets: dropTargets)
    }

    func updateUIView(_ view: SempDockProbeView, context: Context) {}
}

/// The view that reads the window it is in.
final class SempDockProbeView: UIView {

    // MARK: - Dependencies
    private let dock: SempDock
    private let dropTargets: DropTargetRegistry

    // MARK: - Properties
    private var displayLink: CADisplayLink?
    private weak var tabBarController: UITabBarController?

    // MARK: - Init
    init(dock: SempDock, dropTargets: DropTargetRegistry) {
        self.dock = dock
        self.dropTargets = dropTargets
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: - Lifecycle
    override func didMoveToWindow() {
        super.didMoveToWindow()
        displayLink?.invalidate()
        displayLink = nil
        guard let window else {
            dropTargets.topLayer = nil
            dock.read(.noTabBar)
            return
        }
        dropTargets.topLayer = { [weak window] point in
            window.flatMap { PresentationLayer.presentation(at: point, in: $0) }
        }
        // The link holds its target until it is invalidated, which leaving the window does.
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 10)
        link.add(to: .main, forMode: .common)
        displayLink = link
        tick()
    }

    // MARK: - Reading
    @objc
    private func tick() {
        guard let window else { return }
        dock.read(Self.reading(of: window, tabBarController: findTabBarController(in: window)))
    }

    private func findTabBarController(in window: UIWindow) -> UITabBarController? {
        if let tabBarController, tabBarController.view.window === window { return tabBarController }
        var queue = window.rootViewController.map { [$0] } ?? []
        while !queue.isEmpty {
            let controller = queue.removeFirst()
            if let found = controller as? UITabBarController {
                tabBarController = found
                return found
            }
            queue.append(contentsOf: controller.children)
        }
        return nil
    }

    private static func reading(of window: UIWindow, tabBarController: UITabBarController?) -> SempDockReading {
        let alertShown = topPresented(in: window) is UIAlertController
        guard let tabBarController, tabBarController.prominentTabIdentifier != nil,
              let button = prominentButton(of: tabBarController.tabBar) else {
            return SempDockReading(slot: nil, slotOnTop: false, alertShown: alertShown)
        }
        let slot = button.convert(button.bounds, to: nil)
        let reached = window.hitTest(CGPoint(x: slot.midX, y: slot.midY), with: nil)
        let onTop = reached?.isDescendant(of: tabBarController.tabBar) ?? false
        return SempDockReading(slot: slot, slotOnTop: onTop, alertShown: alertShown)
    }

    /// The prominent tab's button: the square view the tab bar shows apart from the others, at its trailing end.
    private static func prominentButton(of tabBar: UITabBar) -> UIView? {
        guard tabBar.window != nil, !tabBar.isHidden, tabBar.alpha > 0.01 else { return nil }
        return tabBar.subviews
            .filter { !$0.isHidden && $0.alpha > 0.01 && $0.frame.width > 0 }
            .filter { abs($0.frame.width - $0.frame.height) < 1 && $0.frame.minX > tabBar.bounds.midX }
            .max { $0.frame.minX < $1.frame.minX }
    }

    private static func topPresented(in window: UIWindow) -> UIViewController? {
        var controller = window.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }
}
#endif
