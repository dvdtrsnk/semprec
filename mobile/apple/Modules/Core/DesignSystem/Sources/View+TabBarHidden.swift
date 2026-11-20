import SwiftUI

extension View {

    /// Hides the tab bar of the window while `hidden`, for a panel that takes its place. A macOS window has no tab bar.
    public func tabBarHidden(_ hidden: Bool) -> some View {
        #if os(iOS)
            toolbarVisibility(hidden ? .hidden : .automatic, for: .tabBar)
        #else
            self
        #endif
    }
}
