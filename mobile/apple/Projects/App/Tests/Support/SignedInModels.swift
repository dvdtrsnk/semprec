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

    func makeJournal(initialDay: String) -> any JournalScreenModel { real.makeJournal(initialDay: initialDay) }

    func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel {
        real.makeJournalSubpage(itemId: itemId)
    }

    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel {
        real.makeSleep(night: night, startOnNight: startOnNight)
    }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
