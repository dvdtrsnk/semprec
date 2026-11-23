package cz.semprec.app.sdk

import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.AudioPlayer
import cz.semprec.app.core.AudioRecorder
import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.PushSubscriptionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.UnavailableAudioPlayer
import cz.semprec.app.core.UnavailableAudioRecorder
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.FileMailThreadListCache
import cz.semprec.app.data.HttpAuthRepository
import cz.semprec.app.data.HttpCollectionReads
import cz.semprec.app.data.HttpCollectionWrites
import cz.semprec.app.data.HttpInboxRepository
import cz.semprec.app.data.HttpOverviewRepository
import cz.semprec.app.data.HttpPushRepository
import cz.semprec.app.data.HttpSearchRepository
import cz.semprec.app.data.InMemoryPlaceholderRepository
import cz.semprec.app.data.OfflineLayer
import cz.semprec.app.data.OfflineWarmup
import cz.semprec.app.data.SyncSocket
import cz.semprec.app.data.WorkData
import cz.semprec.app.domain.InMemoryRecentSearches
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.LoadOverview
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.domain.MailThreadListCache
import cz.semprec.app.domain.NoMailThreadListCache
import cz.semprec.app.domain.RevokePushSubscription
import cz.semprec.app.domain.SearchEverything
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.note.PageChanges
import cz.semprec.app.presentation.CollectionTarget
import cz.semprec.app.presentation.CollectionViewModel
import cz.semprec.app.presentation.CollectionViewModelFactory
import cz.semprec.app.presentation.DetailViewModel
import cz.semprec.app.presentation.HomeViewModel
import cz.semprec.app.presentation.HomeViewModelFactory
import cz.semprec.app.presentation.InboxViewModelFactory
import cz.semprec.app.presentation.ItemDetailsViewModel
import cz.semprec.app.presentation.ItemViewModel
import cz.semprec.app.presentation.LoginViewModel
import cz.semprec.app.presentation.OverviewViewModel
import cz.semprec.app.presentation.OverviewViewModelFactory
import cz.semprec.app.presentation.SearchViewModel
import cz.semprec.app.presentation.SessionViewModel
import cz.semprec.app.presentation.SettingsViewModel
import cz.semprec.app.presentation.TasksStart
import cz.semprec.app.presentation.TasksViewModel
import cz.semprec.app.presentation.WorkViewModelFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.emptyFlow

/**
 * Native SDK and composition root of the screens. Its owner decides which screens share its data:
 * Apple owns one instance per window (the one `SharedScreenModelFactory` of each window's `AppComposition`),
 * Android one per process (the Koin `single` in `AppModule.kt`), which every `MainActivity` of the process shares.
 * State that must not be shared between windows or activities therefore does not belong in it. Every call creates
 * a new screen ViewModel that the caller owns: Android retains it in a `ViewModelStore`, SwiftUI releases it
 * through `close()` when the screen is gone.
 *
 * [sessionStorage] is where the signed-in session survives a restart (the Keychain on Apple); the default forgets
 * it with the process. [cacheDirectory] is a directory the system may empty (the app's cache directory), where the
 * mail thread lists of the signed-in account are kept so they open at once and without a connection; `null` keeps
 * none. Every end of the session empties it: signing out, the server refusing the session, and a restore of a session
 * the server no longer knows. [dataDirectory] is a directory the system keeps (Application Support on Apple), where the
 * answers of the offline set are kept for the signed-in account, so its screens open from the device and without a
 * connection; every window of the process that names it shares what is kept there, and every end of the session
 * empties it as well. The window reads that set ahead of its screens ([OfflineWarmup]) when it starts with a session
 * and when the connection comes back. `null` keeps nothing and every request goes to the server
 * (docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md). [device] is recorded by the server at sign-in. [recorder] and [player] are the device's
 * microphone and speaker; the defaults have neither. [pushSubscriptions] holds the id of this device's push
 * subscription, which [DevicePushSDK] registers; signing out revokes it before the server ends the session.
 *
 * The sync socket of the window ([sync]) tells the calendar, invitation and mailbox screens of this SDK when the
 * server changed what they show.
 */
class HomeSDK(
    sessionStorage: SessionStorage = InMemorySessionStorage(),
    device: DeviceInfo =
        DeviceInfo(AppPlatform.IOS, "00000000-0000-4000-8000-000000000000", "Device", "iphone", "0", "0"),
    recorder: AudioRecorder = UnavailableAudioRecorder(),
    player: AudioPlayer = UnavailableAudioPlayer(),
    pushSubscriptions: PushSubscriptionStorage = InMemoryPushSubscriptionStorage(),
    cacheDirectory: String? = null,
    dataDirectory: String? = null,
) {
    private val repository = InMemoryPlaceholderRepository()
    private val offline: OfflineLayer? = dataDirectory?.let(OfflineLayer::shared)
    private val auth = HttpAuthRepository(
        ApiClient(),
        sessionStorage,
        device,
        sessionEnded = {
            threadLists.clear()
            offline?.clear()
        },
        endingSession = { ending -> RevokePushSubscription(HttpPushRepository(ending), pushSubscriptions)() },
        changes = ItemChanges(offline?.changes ?: emptyFlow()),
        offline = offline,
    )

    init {
        offline?.warmUpWith(OfflineWarmup(auth.api))
    }
    private val threadLists: MailThreadListCache =
        cacheDirectory?.let { FileMailThreadListCache(it, auth.api) } ?: NoMailThreadListCache()
    private val viewModels =
        HomeViewModelFactory(LoadPlaceholderItems(repository), LoadPlaceholderItem(repository), auth)
    private val collectionReads = HttpCollectionReads(auth.api)
    private val syncChanges = SyncChanges()
    private val pageChanges = PageChanges(offline?.pages?.changed ?: emptyFlow())

    /** The sync socket of this window. */
    val sync: SyncSDK = SyncSDK(
        SyncSocket(auth.api, syncChanges, CoroutineScope(SupervisorJob() + Dispatchers.Default), offline, pageChanges),
    )

    /** The profile and the account screens below it. */
    val account: AccountSDK = AccountSDK.create(auth.api, auth, collectionReads)

    /** The generic collection screens: any database's items, and one item of it. */
    val collections: CollectionSDK =
        CollectionSDK(
            CollectionViewModelFactory(
                collectionReads,
                HttpCollectionWrites(auth.api, collectionReads),
                auth.api.changes.events,
            ),
        )

    private val inboxRepository = HttpInboxRepository(auth.api, collectionReads)

    /** The Inbox screen: the stack of cards the person approves, edits or discards. */
    val inbox: InboxSDK = InboxSDK(InboxViewModelFactory(inboxRepository, inboxRepository, auth.api.changes.events))

    // The overview and its search; the recent searches live as long as this SDK, that is, as long as the window.
    private val overviewViewModels = OverviewViewModelFactory(
        LoadOverview(HttpOverviewRepository(auth.api)),
        SearchEverything(HttpSearchRepository(auth.api)),
        InMemoryRecentSearches(),
        auth,
        auth.api.changes.events,
    )

    // The task lists and the Podrobnosti sheet; any write of the window reaches the open lists of the same window.
    private val work = WorkData(auth.api)
    private val workViewModels = WorkViewModelFactory(work.tasks, work.details, work.catalog, auth.api.changes)

    /** The area screen. */
    val areas: AreasSDK = AreasSDK.create(
        collectionReads,
        HttpCollectionWrites(auth.api, collectionReads),
        work.tasks,
        auth.api.changes,
    )

    /** The Tasks screen. [today] is `yyyy-MM-dd`, asked again whenever the screen groups its tasks. */
    fun tasksViewModel(today: () -> String, start: TasksStart): TasksViewModel =
        workViewModels.tasksViewModel(today, start)

    /** The Podrobnosti sheet of the task or event [itemId]. */
    fun itemDetailsViewModel(kind: ItemKind, itemId: String): ItemDetailsViewModel =
        workViewModels.itemDetailsViewModel(kind, itemId)

    /** The mail screens: the thread list, a thread, writing a message, the mailboxes and the accounts. */
    val mail: MailSDK = MailSDK(auth.api, syncChanges, threadLists)

    /** The mail signals of a project: which people, domains and keywords mark its threads. */
    val mailSignals: MailSignalsSDK = MailSignalsSDK(auth.api)

    fun homeViewModel(): HomeViewModel = viewModels.homeViewModel()

    fun overviewViewModel(): OverviewViewModel = overviewViewModels.overviewViewModel()

    fun searchViewModel(): SearchViewModel = overviewViewModels.searchViewModel()

    fun detailViewModel(itemId: String): DetailViewModel = viewModels.detailViewModel(itemId)

    fun settingsViewModel(): SettingsViewModel = viewModels.settingsViewModel()

    fun sessionViewModel(): SessionViewModel = viewModels.sessionViewModel()

    fun loginViewModel(): LoginViewModel = viewModels.loginViewModel()

    /** The diary. */
    val journal: JournalSDK = JournalSDK(auth.api)

    /** The note editor of pages, Journal periods and texts kept elsewhere. */
    val noteEditor: NoteEditorSDK = NoteEditorSDK(auth.api, pageChanges)

    /** The sleep plans, night exceptions and settings. */
    val sleep: SleepSDK = SleepSDK(auth.api)

    /** The calendar, its calendars list, its invitations and the new item form. */
    val calendar: CalendarSDK = CalendarSDK(auth.api, syncChanges)

    /** The assistant: the chat and its history, the status of Semp, runs, approvals, a project's agent and the bubble. */
    val semp: SempSDK = SempSDK(auth.api)

    /** The recordings, the recorder, the transcript and the page of an event. */
    val recordings: RecordingsSDK = RecordingsSDK.create(auth.api, work.details, recorder, player)
}

/** The screens of the generic collection engine; [HomeSDK.collections] hands it out. */
class CollectionSDK internal constructor(private val factory: CollectionViewModelFactory) {

    /** A collection of the items of one database that [target] selects. */
    fun collectionViewModel(target: CollectionTarget): CollectionViewModel = factory.collectionViewModel(target)

    /** The detail of one item; [databaseKeyHint] is the canonical key of its database, if the caller knows it. */
    fun itemViewModel(itemId: String, databaseKeyHint: String?): ItemViewModel =
        factory.itemViewModel(itemId, databaseKeyHint)
}
