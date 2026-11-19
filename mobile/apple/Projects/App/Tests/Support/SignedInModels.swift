import CoreKit

/// The real screen models of a scene, except that the session is already signed in, so a test of the scene's tabs
/// does not stop at the sign-in form.
@MainActor
final class SignedInModels: ScreenModelFactory {

    // MARK: - Dependencies
    private let real = SharedScreenModelFactory(sessionStore: .memory)

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

    func makeJournal(initialDay: String) -> any JournalScreenModel { real.makeJournal(initialDay: initialDay) }

    func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel {
        real.makeJournalSubpage(itemId: itemId)
    }

    func makeNoteEditor(source: NoteEditorSource) -> any NoteEditorScreenModel { real.makeNoteEditor(source: source) }

    func makeInboxCapture() -> any InboxCaptureScreenModel { real.makeInboxCapture() }

    func makeCalendarAgenda(from day: String) -> any CalendarAgendaScreenModel { real.makeCalendarAgenda(from: day) }

    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel {
        real.makeSleep(night: night, startOnNight: startOnNight)
    }

    func makeCalendar(initialDay: String) -> any CalendarScreenModel { real.makeCalendar(initialDay: initialDay) }

    func makeCalendarList() -> any CalendarListScreenModel { real.makeCalendarList() }

    func makeInvitations() -> any InvitationsScreenModel { real.makeInvitations() }

    func makeNewItem(day: String) -> any NewItemScreenModel { real.makeNewItem(day: day) }
    // MARK: - Account
    func makeProfile() -> any ProfileScreenModel { real.makeProfile() }

    func makeDevices() -> any DevicesScreenModel { real.makeDevices() }

    func makeNotificationSettings() -> any NotificationSettingsScreenModel { real.makeNotificationSettings() }

    func makeAiUsage() -> any AiUsageScreenModel { real.makeAiUsage() }

    func makeTrash() -> any TrashScreenModel { real.makeTrash() }

    // MARK: - Areas
    func makeArea(areaId: String) -> any AreaScreenModel { real.makeArea(areaId: areaId) }

    // MARK: - Notes
    func makeNotes(itemId: String) -> any NotesScreenModel { real.makeNotes(itemId: itemId) }
    func makeInbox() -> any InboxScreenModel { real.makeInbox() }
    // MARK: - Mail
    func makeMailThreads(start: MailListStart) -> any MailThreadsScreenModel { real.makeMailThreads(start: start) }

    func makeMailThread(threadId: String) -> any MailThreadScreenModel { real.makeMailThread(threadId: threadId) }

    func makeMailCompose(start: MailComposeStart) -> any MailComposeScreenModel { real.makeMailCompose(start: start) }

    func makeMailFolders() -> any MailFoldersScreenModel { real.makeMailFolders() }

    func makeMailAccounts() -> any MailAccountsScreenModel { real.makeMailAccounts() }

    func makeMailAccount(mailboxId: String) -> any MailAccountScreenModel { real.makeMailAccount(mailboxId: mailboxId) }

    func makeSempThread(
        start: SempThreadStart,
        threadId: String?,
        inboxItemId: String?,
        title: String?,
        meta: String?
    ) -> any SempThreadScreenModel {
        real.makeSempThread(start: start, threadId: threadId, inboxItemId: inboxItemId, title: title, meta: meta)
    }

    func makeSempChats() -> any SempChatsScreenModel { real.makeSempChats() }

    func makeSempStatus() -> any SempStatusScreenModel { real.makeSempStatus() }

    func makeSempRun(runId: String, messageId: String?) -> any SempRunScreenModel {
        real.makeSempRun(runId: runId, messageId: messageId)
    }

    func makeSempApprovals() -> any SempApprovalsScreenModel { real.makeSempApprovals() }

    func makeSempProjectAgent(projectId: String) -> any SempProjectAgentScreenModel {
        real.makeSempProjectAgent(projectId: projectId)
    }

    func makeSempBubble() -> any SempBubbleScreenModel { real.makeSempBubble() }

    func makeRecordings() -> any RecordingsScreenModel { real.makeRecordings() }
    func makeRecorder(eventId: String?) -> any RecorderScreenModel { real.makeRecorder(eventId: eventId) }
    func makeTranscript(transcriptId: String) -> any TranscriptScreenModel {
        real.makeTranscript(transcriptId: transcriptId)
    }
    func makeMeeting(eventId: String) -> any MeetingScreenModel { real.makeMeeting(eventId: eventId) }

    func makeSession() -> any SessionScreenModel {
        ScriptedSessionScreenModel(
            state: .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
    }
}
