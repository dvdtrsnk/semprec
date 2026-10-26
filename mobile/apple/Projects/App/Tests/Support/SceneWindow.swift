import SwiftUI
import XCTest

/// A window of the test host that shows one view, as `WindowGroup` shows one `AppScene` per window, and tells what
/// the window shows of its navigation. Only the window type and the way to read its navigation differ between the
/// platforms.
@MainActor
final class SceneWindow {

    // MARK: - Properties
    #if os(macOS)
        private var window: NSWindow?
    #else
        private let windowScene: UIWindowScene
        private var window: UIWindow?
    #endif

    // MARK: - Init
    init() throws {
        #if !os(macOS)
            windowScene = try XCTUnwrap(
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
                "The test host must have a window scene"
            )
        #endif
    }

    // MARK: - Methods
    /// Shows `content` and returns after it appeared and its appearance tasks, such as NavigatorUI registering the
    /// destination provider, had time to run.
    func show(_ content: some View) async throws {
        let appearance = Appearance()
        let root = content.onAppear { appearance.appeared = true }
        #if os(macOS)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            let controller = NSHostingController(rootView: root)
            // The window keeps its size; sized to the content, a tab view collapses it to no width.
            controller.sizingOptions = []
            window.contentViewController = controller
            window.setContentSize(NSSize(width: 480, height: 640))
            window.makeKeyAndOrderFront(nil)
        #else
            let window = UIWindow(windowScene: windowScene)
            window.rootViewController = UIHostingController(rootView: root)
            window.isHidden = false
        #endif
        self.window = window
        let deadline = ContinuousClock.now + .seconds(5)
        while !appearance.appeared, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(appearance.appeared, "The scene must appear")
        try await Task.sleep(for: .milliseconds(300))
    }

    /// Closes the window and drops its view, as closing a window or discarding a scene does.
    func close() {
        #if os(macOS)
            window?.contentViewController = nil
            window?.close()
        #else
            window?.isHidden = true
            window?.rootViewController = nil
        #endif
        window = nil
    }
}

// MARK: - Navigation
extension SceneWindow {

    /// The navigation title of the top screen of the selected tab's stack: the window's title on macOS, the title of
    /// the selected tab's navigation controller's top view controller on iOS.
    var stackTitle: String? {
        #if os(macOS)
            window?.title
        #else
            selectedTabStack?.topViewController?.navigationItem.title
        #endif
    }

    /// Whether the window presents a sheet.
    var presentsSheet: Bool {
        #if os(macOS)
            window?.attachedSheet != nil
        #else
            window?.rootViewController?.presentedViewController != nil
        #endif
    }

    #if os(iOS)
        /// The navigation title of the top screen of the presented sheet's own stack. A macOS sheet window shows no
        /// title, so only iOS can tell which screen the sheet shows.
        var sheetTitle: String? {
            var presented = window?.rootViewController?.presentedViewController
            while let next = presented?.presentedViewController { presented = next }
            return presented.flatMap(Self.firstNavigationController)?.topViewController?.navigationItem.title
        }

        /// The navigation controller of the selected tab; SwiftUI builds a tab view and its stacks from UIKit
        /// controllers on iOS.
        private var selectedTabStack: UINavigationController? {
            guard let tabs = window?.rootViewController.flatMap(Self.firstTabBarController) else { return nil }
            return tabs.selectedViewController.flatMap(Self.firstNavigationController)
        }

        private static func firstTabBarController(in controller: UIViewController) -> UITabBarController? {
            if let tabs = controller as? UITabBarController { return tabs }
            return controller.children.lazy.compactMap(firstTabBarController).first
        }

        private static func firstNavigationController(in controller: UIViewController) -> UINavigationController? {
            if let stack = controller as? UINavigationController { return stack }
            return controller.children.lazy.compactMap(firstNavigationController).first
        }
    #endif

    #if os(macOS)
        /// Clicks the row `row` of the window's list at its vertical middle, `fraction` of the row's width from its
        /// leading edge, as a pointer click of the user does.
        func clickRow(_ row: Int, atFraction fraction: CGFloat) throws {
            let window = try XCTUnwrap(window, "The window must be shown")
            let list = try XCTUnwrap(window.contentView.flatMap(Self.firstTable), "The window must show a list")
            let bounds = list.rect(ofRow: row)
            let point = list.convert(NSPoint(x: bounds.minX + bounds.width * fraction, y: bounds.midY), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(
                    with: type,
                    location: point,
                    modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber,
                    context: nil,
                    eventNumber: 0,
                    clickCount: 1,
                    pressure: 1
                ))
                window.sendEvent(event)
            }
        }

        /// The number of rows of the window's list, or nil when it shows none.
        var listRowCount: Int? {
            window?.contentView.flatMap(Self.firstTable)?.numberOfRows
        }

        private static func firstTable(in view: NSView) -> NSTableView? {
            if let table = view as? NSTableView { return table }
            return view.subviews.lazy.compactMap(firstTable).first
        }
    #endif
}

/// Whether the shown view appeared.
@MainActor
private final class Appearance {

    // MARK: - Properties
    var appeared = false
}
