import SwiftUI

// MARK: - Adaptive tab navigation
extension View {

    /// Lets a tab view turn into a sidebar where there is room for one (iPad), and into the floating tab bar on
    /// iPhone. On macOS the tab view keeps its plain style: a macOS sidebar tab view keeps the tabs' content closures
    /// alive after its window closed, and with them the scene's composition and its Kotlin SDK
    /// (`SceneLifetimeTests`).
    public func adaptiveTabNavigation() -> some View {
        #if os(macOS)
            self
        #else
            tabViewStyle(.sidebarAdaptable)
        #endif
    }
}
