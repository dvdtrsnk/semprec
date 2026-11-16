import SwiftUI

// MARK: - Full-screen cover
extension View {

    /// Presents `content` over the whole screen on iOS; a macOS window has no full-screen cover, so it is a sheet.
    public func fullScreenCoverOrSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
            fullScreenCover(isPresented: isPresented, content: content)
        #else
            sheet(isPresented: isPresented, content: content)
        #endif
    }
}
