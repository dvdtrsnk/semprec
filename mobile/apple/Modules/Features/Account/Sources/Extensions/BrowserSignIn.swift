import AuthenticationServices
import SwiftUI

/// Shows a provider's sign-in page in the system's browser sheet and waits until the page sends the browser back to
/// `alldots://oauth`. A screen builds it from its `webAuthenticationSession` environment value, so the sheet is shown
/// over the window of the view that started the sign-in.
struct BrowserSignIn {

    /// How a browser sign-in ended: back at the app with an address, closed by the person, or failed on its own.
    enum Outcome: Equatable {

        case returned(URL)
        case cancelled
        case failed
    }

    /// The scheme the server sends the browser back to; the app target registers it.
    static let callbackScheme = "alldots"

    // MARK: - Dependencies
    private let authenticate: @MainActor (URL) async throws -> URL

    // MARK: - Init
    init(_ session: WebAuthenticationSession) {
        authenticate = { url in
            try await session.authenticate(
                using: url,
                callback: .customScheme(Self.callbackScheme),
                preferredBrowserSession: nil,
                additionalHeaderFields: [:]
            )
        }
    }

    /// Answers with `authenticate` instead of a browser, for tests.
    init(authenticate: @escaping @MainActor (URL) async throws -> URL) {
        self.authenticate = authenticate
    }

    // MARK: - Methods
    /// Opens `address`; an address that is no URL fails without showing anything.
    @MainActor
    func open(_ address: String) async -> Outcome {
        guard let url = URL(string: address) else { return .failed }
        do {
            return .returned(try await authenticate(url))
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return .cancelled
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failed
        }
    }
}
