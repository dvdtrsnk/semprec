import SwiftUI

/// Semantic design tokens. Views take colors, spacing and fonts from here instead of literal values.
public enum Theme {

    // MARK: - Colors
    public enum Colors {

        /// Status symbols and other emphasis that follows the app's tint.
        public static let accent = Color.accentColor
        /// Text that supports a primary label.
        public static let secondaryText = Color.secondary
        /// The strongest fill of the app: primary buttons and the app mark. Black in light mode, white in dark mode;
        /// text on it uses `.foregroundStyle(.background)`.
        public static let brand = Color.primary
        /// A refused or destructive state.
        public static let destructive = Color.red
        /// The page behind grouped cards.
        public static var groupedBackground: Color {
            #if os(iOS)
                Color(.systemGroupedBackground)
            #else
                Color(nsColor: .windowBackgroundColor)
            #endif
        }
        /// A grouped card on `groupedBackground`.
        public static var card: Color {
            #if os(iOS)
                Color(.secondarySystemGroupedBackground)
            #else
                Color(nsColor: .controlBackgroundColor)
            #endif
        }
    }

    // MARK: - Opacity
    public enum Opacity {

        /// The content of a control while it is pressed.
        public static let pressed: Double = 0.5
    }

    // MARK: - Spacing
    public enum Spacing {

        public static let small: CGFloat = 8
        public static let medium: CGFloat = 16
        public static let large: CGFloat = 24
        /// Space above the header of a full-screen form.
        public static let hero: CGFloat = 72
    }

    // MARK: - Radius
    public enum Radius {

        /// A grouped card.
        public static let card: CGFloat = 26
    }

    // MARK: - Layout
    public enum Layout {

        /// The widest a form grows on a wide screen.
        public static let formWidth: CGFloat = 440
        public static let rowHeight: CGFloat = 50
        public static let buttonHeight: CGFloat = 52
    }

    // MARK: - Typography
    public enum Typography {

        public static let title = Font.title2.weight(.semibold)
        public static let body = Font.body
    }
}
