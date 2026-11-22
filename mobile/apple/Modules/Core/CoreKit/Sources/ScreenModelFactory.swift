import Foundation

/// Creates one new screen model per call. The caller (a screen's ViewModel) owns the result; releasing
/// it closes the shared ViewModel behind it.
@MainActor
public protocol ScreenModelFactory: AnyObject, Sendable {

    // MARK: - Live updates
    /// Connects the scene's sync socket with the signed-in session and keeps it connected, so the calendar, the
    /// invitations and the mailboxes show what the server changed; signed out, it does nothing. Calling it while the
    /// socket runs changes nothing.
    func startLiveUpdates()
    /// Closes the scene's sync socket until the next `startLiveUpdates()`.
    func stopLiveUpdates()

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
    func makeNoteEditor(source: NoteEditorSource) -> any NoteEditorScreenModel
    /// The capture row of the diary's Inbox.
    func makeInboxCapture() -> any InboxCaptureScreenModel
    /// The calendar as a list from `day` (`YYYY-MM-DD`) on.
    func makeCalendarAgenda(from day: String) -> any CalendarAgendaScreenModel

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
    /// The internet accounts with their services, and one of them; an account is a mailbox, so `accountId` is the id
    /// of its Mailboxes item.
    func makeInternetAccounts() -> any InternetAccountsScreenModel
    func makeInternetAccount(accountId: String) -> any InternetAccountScreenModel

    // MARK: - Areas
    func makeArea(areaId: String) -> any AreaScreenModel

    // MARK: - Inbox
    func makeInbox() -> any InboxScreenModel
    // MARK: - Mail
    func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel
    func makeMailThread(threadId: String) -> any MailThreadScreenModel
    func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel
    func makeMailFolders() -> any MailFoldersScreenModel
    /// The mail signals of a project: which people, domains and keywords mark its threads, with the threads they match.
    func makeProjectMailSignals(projectId: String) -> any ProjectMailSignalsScreenModel

    // Semp slice
    /// A conversation. `threadId` names the thread of `.existing`, `inboxItemId` the Inbox item of `.item`; `title`
    /// and `meta` name what the thread is about, as the screen that opened it knows.
    func makeSempThread(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?
    ) -> any SempThreadScreenModel
    func makeSempChats() -> any SempChatsScreenModel
    func makeSempStatus() -> any SempStatusScreenModel
    func makeSempRun(runId: String, messageId: String?) -> any SempRunScreenModel
    func makeSempApprovals() -> any SempApprovalsScreenModel
    func makeSempProjectAgent(projectId: String) -> any SempProjectAgentScreenModel
    func makeSempBubble() -> any SempBubbleScreenModel

    // MARK: - Recordings
    func makeRecordings() -> any RecordingsScreenModel
    /// The recorder of a recording that belongs to the event `eventId`, or to none.
    func makeRecorder(eventId: String?) -> any RecorderScreenModel
    func makeTranscript(transcriptId: String) -> any TranscriptScreenModel
    func makeMeeting(eventId: String) -> any MeetingScreenModel
}
