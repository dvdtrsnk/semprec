import SwiftUI

/// Whether something on screen takes the bottom of it, where floating controls such as the Semp bubble would cover it.
public struct FloatingControlsHiddenKey: PreferenceKey {

    public static let defaultValue = false

    public static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

// MARK: - Floating controls
extension View {

    /// Asks the floating controls of the scene to step aside while this view is shown.
    public func hidesFloatingControls() -> some View {
        preference(key: FloatingControlsHiddenKey.self, value: true)
    }
}
