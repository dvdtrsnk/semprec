@preconcurrency internal import SharedSDK

/// Creates the screen models from one Kotlin `HomeSDK`, which owns the data of one app scene.
@MainActor
public final class SharedScreenModelFactory {

    // MARK: - Types
    /// Where the session of the signed-in person is kept.
    public enum SessionStore: Sendable {
        /// The Keychain of the device, so the person stays signed in across launches.
        case keychain
        /// The memory of this process only. Tests use it, so that a session another build stored on the same device
        /// never reaches them.
        case memory
    }

    // MARK: - Dependencies
    let sdk: SharedSDK.HomeSDK

    // MARK: - Init
    public init(sessionStore: SessionStore = .keychain) {
        let storage: any SharedSDK.SessionStorage = switch sessionStore {
        case .keychain: KeychainSessionStorage()
        case .memory: SharedSDK.InMemorySessionStorage()
        }
        sdk = SharedSDK.HomeSDK(
            sessionStorage: storage,
            device: DeviceIdentity.current(),
            recorder: DeviceAudioRecorder(),
            player: DeviceAudioPlayer()
        )
    }
}

// MARK: - Protocol conformance
extension SharedScreenModelFactory: ScreenModelFactory {

    public func makeSession() -> any SessionScreenModel {
        SharedSessionScreenModel(sdk.sessionViewModel())
    }

    public func makeLogin() -> any LoginScreenModel {
        SharedLoginScreenModel(sdk.loginViewModel())
    }

    public func makeOverview() -> any OverviewScreenModel {
        SharedOverviewScreenModel(sdk.overviewViewModel())
    }

    public func makeSearch() -> any SearchScreenModel {
        SharedSearchScreenModel(sdk.searchViewModel())
    }

    public func makeTasks(start: TasksStart) -> any TasksScreenModel {
        let shared = SharedSDK.TasksStart(
            tab: start.tab.shared,
            hideDone: start.hideDone,
            areaId: start.areaId,
            projectId: start.projectId
        )
        return SharedTasksScreenModel(sdk.tasksViewModel(today: { IsoDay.today() }, start: shared))
    }

    public func makeItemDetails(kind: ItemKind, itemId: String) -> any ItemDetailsScreenModel {
        SharedItemDetailsScreenModel(sdk.itemDetailsViewModel(kind: kind.shared, itemId: itemId))
    }

    // Journal slice
    public func makeJournal(initialDay: String) -> any JournalScreenModel {
        SharedJournalScreenModel(sdk.journal.journalViewModel(initialDay: initialDay))
    }

    public func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel {
        SharedJournalSubpageScreenModel(sdk.journal.journalSubpageViewModel(itemId: itemId))
    }

    public func makeInboxCapture() -> any InboxCaptureScreenModel {
        SharedInboxCaptureScreenModel(sdk.journal.inboxCaptureViewModel())
    }

    public func makeCalendarAgenda(from day: String) -> any CalendarAgendaScreenModel {
        SharedCalendarAgendaScreenModel(sdk.calendar.calendarAgendaViewModel(from: day))
    }

    public func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel {
        SharedSleepScreenModel(sdk.sleep.sleepViewModel(night: night, startOnNight: startOnNight))
    }

    // Calendar slice
    public func makeCalendar(initialDay: String) -> any CalendarScreenModel {
        SharedCalendarScreenModel(sdk.calendar.calendarViewModel(initialDay: initialDay))
    }

    public func makeCalendarList() -> any CalendarListScreenModel {
        SharedCalendarListScreenModel(sdk.calendar.calendarListViewModel())
    }

    public func makeInvitations() -> any InvitationsScreenModel {
        SharedInvitationsScreenModel(sdk.calendar.invitationsViewModel())
    }

    public func makeNewItem(day: String) -> any NewItemScreenModel {
        SharedNewItemScreenModel(sdk.calendar.itemFormViewModel(day: day))
    }
}
