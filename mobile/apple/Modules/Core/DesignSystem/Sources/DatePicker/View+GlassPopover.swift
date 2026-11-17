import SwiftUI

// MARK: - Glass popover
extension View {

    /// Presents `content` in a popover anchored to this view, which is a small floating glass panel on iOS 26 and on
    /// macOS, also on iPhone, where a popover would otherwise become a full sheet. Meant for the date and time
    /// pickers.
    ///
    /// The popover is a named modifier, not an opaque `some View` built from `popover(...)`: a Release build of a
    /// feature that spelled the opaque type of SwiftUI's `popover` in its own metadata failed to link (the symbol is
    /// not exported by the SDK).
    public func glassPopover<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> ModifiedContent<Self, GlassPopover<Content>> {
        modifier(GlassPopover(isPresented: isPresented, content: content))
    }
}

// MARK: - Modifier
public struct GlassPopover<Content: View>: ViewModifier {

    // MARK: - Properties
    let isPresented: Binding<Bool>
    let content: () -> Content

    // MARK: - Body
    public func body(content base: Self.Content) -> some View {
        base.popover(isPresented: isPresented, arrowEdge: .top) {
            content().presentationCompactAdaptation(.popover)
        }
    }
}
