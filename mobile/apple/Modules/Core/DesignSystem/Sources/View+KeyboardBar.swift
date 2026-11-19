import SwiftUI

// MARK: - Keyboard bar
extension View {

    /// Shows `bar` above the software keyboard on iOS, where the system places a keyboard toolbar; a macOS window has
    /// no software keyboard, so the bar sits at the bottom of the view.
    public func keyboardBar(@ViewBuilder _ bar: () -> some View) -> some View {
        #if os(iOS)
            toolbar { ToolbarItemGroup(placement: .keyboard) { bar() } }
        #else
            safeAreaInset(edge: .bottom) { bar() }
        #endif
    }
}
