import CoreKit

/// The real screen models of a scene, except that the session is already signed in, so a test of the scene's tabs
/// does not stop at the sign-in form.
@MainActor
final class SignedInModels: ScreenModelFactory {

    // MARK: - Dependencies
    private let real = SharedScreenModelFactory()

    // MARK: - Protocol conformance
    func makeLogin() -> any LoginScreenModel { real.makeLogin() }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
