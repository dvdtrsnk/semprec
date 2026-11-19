import SwiftUI

// MARK: - Wheel date picker
extension View {

    /// Shows a time or date picker as wheels on iOS, as an inline form opens it under its row; a Mac has no wheels and
    /// shows the picker's field instead.
    public func wheelDatePicker() -> some View {
        #if os(iOS)
            datePickerStyle(.wheel)
        #else
            datePickerStyle(.field)
        #endif
    }
}
