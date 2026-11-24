import SwiftUI

// MARK: - Section spacing
extension View {

    /// Sets the gap after a section of a grouped form on iOS. A macOS form lays its sections out itself and has no
    /// such gap to set.
    public func sectionSpacing(_ spacing: CGFloat) -> some View {
        #if os(iOS)
            listSectionSpacing(spacing)
        #else
            self
        #endif
    }
}
