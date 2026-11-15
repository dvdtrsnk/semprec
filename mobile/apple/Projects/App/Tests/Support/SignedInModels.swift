import CoreKit

/// The real screen models of a scene, except that the session is already signed in, so a test of the scene's tabs
/// does not stop at the sign-in form.
@MainActor
final class SignedInModels: ScreenModelFactory {

    // MARK: - Dependencies
    private let real = SharedScreenModelFactory()

    // MARK: - Protocol conformance
    func makeHome() -> any HomeScreenModel { real.makeHome() }

    func makeDetail(itemId: String) -> any DetailScreenModel { real.makeDetail(itemId: itemId) }

    func makeSettings() -> any SettingsScreenModel { real.makeSettings() }

    func makeLogin() -> any LoginScreenModel { real.makeLogin() }

    func makeCollection(target: CollectionTarget) -> any CollectionScreenModel { real.makeCollection(target: target) }

    func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel {
        real.makeItem(itemId: itemId, databaseKey: databaseKey)
    }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
