import SwiftUI

// MARK: - Glass popover
extension View {

    /// Presents `content` in a popover anchored to this view, which is a small floating glass panel on iOS 26 and on
    /// macOS, also on iPhone, where a popover would otherwise become a full sheet. Meant for the date and time
    /// pickers.
    public func glassPopover<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        popover(isPresented: isPresented, arrowEdge: .top) {
            content().presentationCompactAdaptation(.popover)
        }
    }
}
