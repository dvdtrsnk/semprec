import SwiftUI

// MARK: - Wheel picker
extension View {

    /// Shows a picker as a wheel on iOS, as a timer asks for hours and minutes; a Mac has no wheels and shows a menu.
    public func wheelPicker() -> some View {
        #if os(iOS)
            pickerStyle(.wheel)
        #else
            pickerStyle(.menu)
        #endif
    }
}
