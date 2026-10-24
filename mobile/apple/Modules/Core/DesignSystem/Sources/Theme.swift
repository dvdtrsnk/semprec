import SwiftUI

/// Semantic design tokens. Views take colors, spacing and fonts from here instead of literal values.
public enum Theme {

    // MARK: - Colors
    public enum Colors {

        /// Status symbols and other emphasis that follows the app's tint.
        public static let accent = Color.accentColor
        /// Text that supports a primary label.
        public static let secondaryText = Color.secondary
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
    }

    // MARK: - Typography
    public enum Typography {

        public static let title = Font.title2.weight(.semibold)
        public static let body = Font.body
    }
}
