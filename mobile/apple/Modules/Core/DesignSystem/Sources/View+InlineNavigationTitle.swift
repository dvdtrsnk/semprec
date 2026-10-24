import SwiftUI

// MARK: - Navigation title
extension View {

    /// Shows the navigation title in the bar instead of large above the content on iOS. A macOS window shows the
    /// title in its toolbar and has no large title to replace.
    public func inlineNavigationTitle() -> some View {
        #if os(iOS)
            navigationBarTitleDisplayMode(.inline)
        #else
            self
        #endif
    }
}
