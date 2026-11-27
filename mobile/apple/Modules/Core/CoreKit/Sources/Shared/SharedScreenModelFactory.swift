import Foundation
@preconcurrency internal import SharedSDK

/// Creates the screen models from one Kotlin `HomeSDK`, which owns the data of one app scene.
@MainActor
public final class SharedScreenModelFactory {

    // MARK: - Types
    /// Where the session of the signed-in person, the id of this device's push subscription, the kept mail thread
    /// lists and the kept offline data are kept.
    public enum SessionStore: Sendable {
        /// The Keychain of the device, so the person stays signed in across launches; the subscription id lives in the
        /// user defaults, the mail thread lists in the app's caches directory and the offline data in
        /// `Application Support/Offline`.
        case keychain
        /// The memory of this process only, with no mail thread lists and no offline data kept. Tests use it, so that
        /// a session or a list another build stored on the same device never reaches them.
        case memory
    }

    // MARK: - Dependencies
    let sdk: SharedSDK.HomeSDK

    // MARK: - Init
    /// `deviceServices` are the process's, which every scene's factory is given by the owner of the process's
    /// notifications; a factory creates none of its own.
    public init(sessionStore: SessionStore = .keychain, deviceServices: DeviceServices) {
        let storage: any SharedSDK.SessionStorage = switch sessionStore {
        case .keychain: KeychainSessionStorage()
        case .memory: SharedSDK.InMemorySessionStorage()
        }
        let subscriptions: any SharedSDK.PushSubscriptionStorage = switch sessionStore {
        case .keychain: DefaultsPushSubscriptionStorage()
        case .memory: SharedSDK.InMemoryPushSubscriptionStorage()
        }
        let cacheDirectory: String? = switch sessionStore {
        case .keychain: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.path
        case .memory: nil
        }
        let dataDirectory: String? = switch sessionStore {
        case .keychain: Self.offlineDirectory()
        case .memory: nil
        }
        sdk = SharedSDK.HomeSDK(
            sessionStorage: storage,
            device: DeviceIdentity.current(),
            recorder: DeviceAudioRecorder(),
            player: DeviceAudioPlayer(),
            pushSubscriptions: subscriptions,
            cacheDirectory: cacheDirectory,
            dataDirectory: dataDirectory,
            wake: deviceServices.wake,
            sleepAlarms: deviceServices.sleepAlarms,
            debugAlarms: deviceServices.debugAlarms
        )
    }

    /// `Application Support/Offline`, which the system does not empty as it may empty the caches, created and excluded
    /// from backups: it holds a copy of the server's data, which a restored device reads again. When the directory
    /// cannot be created or excluded here, its path is still handed over: the shared layer creates it on its first
    /// write, and it is then backed up with the app's other data, which loses nothing.
    private static func offlineDirectory() -> String? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        var directory = support.appendingPathComponent("Offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return directory.path
    }
}

// MARK: - Protocol conformance
extension SharedScreenModelFactory: ScreenModelFactory {

    public func startLiveUpdates() {
        sdk.sync.start()
    }

    public func stopLiveUpdates() {
        sdk.sync.stop()
    }

    public func makeSyncStatus() -> any SyncStatusScreenModel {
        SharedSyncStatusScreenModel(sdk.sync.statusViewModel())
    }

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

    public func makeNoteEditor(source: NoteEditorSource) -> any NoteEditorScreenModel {
        SharedNoteEditorScreenModel(
            sdk.noteEditor.noteEditorViewModel(source: SharedNoteEditorScreenModel.source(source))
        )
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

    public func makeWakeSettings() -> any WakeSettingsScreenModel {
        SharedWakeSettingsScreenModel(sdk.sleep.wakeSettingsViewModel())
    }

    public func makeWakeGuard() -> any WakeGuardScreenModel {
        SharedWakeGuardScreenModel(sdk.sleep.wakeGuardViewModel())
    }

    public func makeDebugAlarms() -> any DebugAlarmScreenModel {
        SharedDebugAlarmScreenModel(sdk.debugAlarmViewModel())
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
