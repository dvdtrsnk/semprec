import CoreKit

/// The real screen models of a scene, except that the session is already signed in, so a test of the scene's tabs
/// does not stop at the sign-in form.
@MainActor
final class SignedInModels: ScreenModelFactory {

    // MARK: - Dependencies
    private let real = SharedScreenModelFactory()

    // MARK: - Protocol conformance
    func makeLogin() -> any LoginScreenModel { real.makeLogin() }

    func makeOverview() -> any OverviewScreenModel { real.makeOverview() }

    func makeSearch() -> any SearchScreenModel { real.makeSearch() }

    func makeTasks(start: TasksStart) -> any TasksScreenModel { real.makeTasks(start: start) }

    func makeItemDetails(kind: ItemKind, itemId: String) -> any ItemDetailsScreenModel {
        real.makeItemDetails(kind: kind, itemId: itemId)
    }

    func makeCollection(target: CollectionTarget) -> any CollectionScreenModel { real.makeCollection(target: target) }

    func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel {
        real.makeItem(itemId: itemId, databaseKey: databaseKey)
    }

    // MARK: - Mail
    func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel { real.makeMailThreads(start: start) }

    func makeMailThread(threadId: String) -> any MailThreadScreenModel { real.makeMailThread(threadId: threadId) }

    func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel { real.makeMailCompose(start: start) }

    func makeMailFolders() -> any MailFoldersScreenModel { real.makeMailFolders() }

    func makeMailAccounts() -> any MailAccountsScreenModel { real.makeMailAccounts() }

    func makeMailAccount(mailboxId: String) -> any MailAccountScreenModel { real.makeMailAccount(mailboxId: mailboxId) }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
