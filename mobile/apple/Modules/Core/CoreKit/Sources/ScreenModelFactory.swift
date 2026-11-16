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

    // Journal slice
    /// `initialDay` is the device's current day, `YYYY-MM-DD`; the server's answer names today.
    func makeJournal(initialDay: String) -> any JournalScreenModel
    func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel

    /// The sleep sheet for the evening `night` (`YYYY-MM-DD`, or nil); `startOnNight` opens it on that night.
    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel

    // Calendar slice
    /// `initialDay` is the device's current day, `YYYY-MM-DD`; the server's answer names today.
    func makeCalendar(initialDay: String) -> any CalendarScreenModel
    func makeCalendarList() -> any CalendarListScreenModel
    func makeInvitations() -> any InvitationsScreenModel
    /// `day` is the day the new item sheet was opened for, `YYYY-MM-DD`.
    func makeNewItem(day: String) -> any NewItemScreenModel
    // MARK: - Account
    func makeProfile() -> any ProfileScreenModel
    func makeDevices() -> any DevicesScreenModel
    func makeNotificationSettings() -> any NotificationSettingsScreenModel
    func makeAiUsage() -> any AiUsageScreenModel
    func makeTrash() -> any TrashScreenModel

    // MARK: - Areas
    func makeArea(areaId: String) -> any AreaScreenModel

    // MARK: - Notes
    func makeNotes(itemId: String) -> any NotesScreenModel
    // MARK: - Inbox
    func makeInbox() -> any InboxScreenModel
    // MARK: - Mail
    func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel
    func makeMailThread(threadId: String) -> any MailThreadScreenModel
    func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel
    func makeMailFolders() -> any MailFoldersScreenModel
    func makeMailAccounts() -> any MailAccountsScreenModel
    func makeMailAccount(mailboxId: String) -> any MailAccountScreenModel
}
