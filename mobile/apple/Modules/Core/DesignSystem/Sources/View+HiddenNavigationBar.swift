import SwiftUI

// MARK: - Hidden navigation bar
extension View {

    /// Hides the navigation bar of the screen on iOS, for a screen that draws its own title and buttons. A macOS window
    /// has no navigation bar, so there it changes nothing.
    public func hiddenNavigationBar() -> some View {
        #if os(iOS)
            toolbar(.hidden, for: .navigationBar)
        #else
            self
        #endif
    }
}
