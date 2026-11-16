import Foundation

/// Creates one new screen model per call. The caller (a screen's ViewModel) owns the result; releasing
/// it closes the shared ViewModel behind it.
@MainActor
public protocol ScreenModelFactory: AnyObject, Sendable {

    func makeSession() -> any SessionScreenModel
    func makeLogin() -> any LoginScreenModel
    func makeOverview() -> any OverviewScreenModel
    func makeSearch() -> any SearchScreenModel
    func makeTasks(start: TasksStart) -> any TasksScreenModel
    func makeItemDetails(kind: ItemKind, itemId: String) -> any ItemDetailsScreenModel

    // MARK: - Collections
    func makeCollection(target: CollectionTarget) -> any CollectionScreenModel
    func makeItem(itemId: String, databaseKey: String?) -> any ItemScreenModel

    // MARK: - Mail
    func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel
    func makeMailThread(threadId: String) -> any MailThreadScreenModel
    func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel
    func makeMailFolders() -> any MailFoldersScreenModel
    func makeMailAccounts() -> any MailAccountsScreenModel
    func makeMailAccount(mailboxId: String) -> any MailAccountScreenModel
}
