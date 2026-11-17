import SwiftUI

// MARK: - Grouped list
extension View {

    /// Shows a list as cards on the grouped background, the way the iOS Settings app does. macOS has no inset grouped
    /// list style, so there the list keeps the inset style.
    public func groupedListStyle() -> some View {
        #if os(iOS)
            listStyle(.insetGrouped)
        #else
            listStyle(.inset)
        #endif
    }
}
