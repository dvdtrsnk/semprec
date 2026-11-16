@preconcurrency internal import SharedSDK

/// Creates the screen models from one Kotlin `HomeSDK`, which owns the data of one app scene.
@MainActor
public final class SharedScreenModelFactory {

    // MARK: - Dependencies
    let sdk = SharedSDK.HomeSDK(
        sessionStorage: KeychainSessionStorage(),
        device: DeviceIdentity.current(),
        recorder: DeviceAudioRecorder(),
        player: DeviceAudioPlayer()
    )

    // MARK: - Init
    public init() {}
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
