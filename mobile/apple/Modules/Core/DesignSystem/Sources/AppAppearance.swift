import SwiftUI

/// Whether the app is light, dark or follows the system, as chosen on this device.
public enum AppColorScheme: String, CaseIterable, Sendable {

    case system
    case light
    case dark

    /// The scheme the app shows in; `nil` follows the system.
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// Where this device keeps the chosen appearance.
public enum AppAppearanceKeys {

    public static let colorScheme = "appearanceColorScheme"
}

// MARK: - Appearance
extension View {

    /// The appearance chosen on this device: light, dark or the system's, and the app's accent colour that every
    /// control tints with. The app puts it on each window's content.
    public func appAppearance() -> some View {
        modifier(AppAppearanceModifier())
    }
}

// MARK: - Accent
extension View {

    /// The app's accent colour, for a control that keeps it inside something drawn in the label colour, such as the
    /// check that ends a focus in a toolbar.
    public func accentTint() -> some View {
        tint(Theme.Colors.appAccent)
    }
}

private struct AppAppearanceModifier: ViewModifier {

    @AppStorage(AppAppearanceKeys.colorScheme)
    private var scheme = AppColorScheme.system

    func body(content: Content) -> some View {
        content
            .tint(Theme.Colors.appAccent)
            .preferredColorScheme(scheme.colorScheme)
    }
}
