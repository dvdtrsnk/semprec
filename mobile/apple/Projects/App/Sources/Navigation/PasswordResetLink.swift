import Foundation

/// A password-reset link of alldots.app, as the server mails it: `https://alldots.app/?page=password-reset#token=<t>`.
/// It is the one universal link the app handles; every other address reads as `nil` and opens nothing. The token is
/// kept only to be sent to the link's server and never written anywhere.
struct PasswordResetLink: Identifiable, Equatable {

    // MARK: - Properties
    /// Each opened link is its own sheet, so a second link replaces the form of the first.
    let id = UUID()
    /// The origin of the link, the server the token belongs to.
    let serverUrl: String
    let token: String

    // MARK: - Init
    /// Reads `url` strictly: `https` on `alldots.app` with no port, user or path, exactly one `page` parameter of
    /// value `password-reset` (others, such as a mail client's tracking, are ignored) and a fragment that is exactly
    /// `token=` and a base64url token.
    init?(url: URL) {
        guard
            let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
            parts.scheme?.lowercased() == "https",
            parts.host?.lowercased() == Self.host,
            parts.port == nil, parts.user == nil, parts.password == nil,
            parts.path.isEmpty || parts.path == "/",
            parts.queryItems?.filter({ $0.name == "page" }).map(\.value) == ["password-reset"],
            let token = Self.token(fragment: parts.fragment)
        else { return nil }
        serverUrl = "https://\(Self.host)"
        self.token = token
    }
}

// MARK: - Private
private extension PasswordResetLink {

    static let host = "alldots.app"
    /// A token is 32 random bytes in base64url (43 characters); the bound only refuses absurd input.
    static let maximumTokenLength = 256
    static let tokenCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )

    static func token(fragment: String?) -> String? {
        guard let fragment, fragment.hasPrefix("token=") else { return nil }
        let token = String(fragment.dropFirst("token=".count))
        guard
            !token.isEmpty, token.count <= maximumTokenLength,
            token.unicodeScalars.allSatisfy(tokenCharacters.contains)
        else { return nil }
        return token
    }
}
