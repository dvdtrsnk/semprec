import SwiftUI

// MARK: - Minimized search
extension View {

    /// Lets the search of a `searchable` screen rest as a glass button in the toolbar and grow into the field when it
    /// is tapped, as iOS 26 does. A macOS toolbar keeps its search field open, so there it changes nothing.
    public func minimizedSearchToolbar() -> some View {
        #if os(macOS)
            self
        #else
            searchToolbarBehavior(.minimize)
        #endif
    }
}
