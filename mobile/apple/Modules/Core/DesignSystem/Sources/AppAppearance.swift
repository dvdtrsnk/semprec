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

/// The accent colour of the app's controls, as chosen on this device. Each is a system colour, so it adapts to the
/// light and the dark appearance as the system's own controls do.
public enum AppAccent: String, CaseIterable, Sendable {

    case blue
    case cyan
    case teal
    case mint
    case yellow
    case orange
    case pink
    case purple
    case indigo
    case gray

    public var color: Color {
        switch self {
        case .blue: .blue
        case .cyan: .cyan
        case .teal: .teal
        case .mint: .mint
        case .yellow: .yellow
        case .orange: .orange
        case .pink: .pink
        case .purple: .purple
        case .indigo: .indigo
        case .gray: .gray
        }
    }
}

/// Where this device keeps the chosen appearance.
public enum AppAppearanceKeys {

    public static let colorScheme = "appearanceColorScheme"
    public static let accent = "appearanceAccent"
}

// MARK: - Appearance
extension View {

    /// The appearance chosen on this device: light, dark or the system's, and the accent colour every control tints
    /// with. The app puts it on each window's content.
    public func appAppearance() -> some View {
        modifier(AppAppearanceModifier())
    }
}

// MARK: - Accent
extension View {

    /// The accent colour chosen on this device, for a control that keeps it inside something drawn in the label
    /// colour, such as the check that ends a focus in a toolbar.
    public func accentTint() -> some View {
        modifier(AccentTintModifier())
    }
}

private struct AccentTintModifier: ViewModifier {

    @AppStorage(AppAppearanceKeys.accent)
    private var accent = AppAccent.blue

    func body(content: Content) -> some View {
        content.tint(accent.color)
    }
}

private struct AppAppearanceModifier: ViewModifier {

    @AppStorage(AppAppearanceKeys.colorScheme)
    private var scheme = AppColorScheme.system
    @AppStorage(AppAppearanceKeys.accent)
    private var accent = AppAccent.blue

    func body(content: Content) -> some View {
        content
            .tint(accent.color)
            .preferredColorScheme(scheme.colorScheme)
    }
}
