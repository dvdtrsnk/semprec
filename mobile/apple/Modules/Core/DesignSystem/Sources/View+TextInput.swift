import SwiftUI

/// What a text field holds, which decides the keyboard and the automatic corrections.
public enum TextInputKind {

    /// Free text that is not corrected or capitalized, such as a name of a server.
    case plain
    case email
    case url
}

// MARK: - Text input
extension View {

    /// Turns off automatic capitalization and correction and picks the keyboard for `kind`. A Mac has no on-screen
    /// keyboard and no capitalization, so only the correction applies there.
    public func textInput(_ kind: TextInputKind) -> some View {
        #if os(iOS)
            textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(Self.keyboard(for: kind))
        #else
            autocorrectionDisabled()
        #endif
    }
}

#if os(iOS)
    private extension View {

        static func keyboard(for kind: TextInputKind) -> UIKeyboardType {
            switch kind {
            case .plain: .default
            case .email: .emailAddress
            case .url: .URL
            }
        }
    }
#endif
