package cz.semprec.app.sdk

import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.HttpAuthRepository
import cz.semprec.app.data.HttpCollectionReads
import cz.semprec.app.data.HttpCollectionWrites
import cz.semprec.app.data.HttpOverviewRepository
import cz.semprec.app.data.HttpSearchRepository
import cz.semprec.app.data.InMemoryPlaceholderRepository
import cz.semprec.app.data.WorkData
import cz.semprec.app.domain.InMemoryRecentSearches
import cz.semprec.app.domain.ItemChanges
import cz.semprec.app.domain.LoadOverview
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.domain.SearchEverything
import cz.semprec.app.presentation.CollectionTarget
import cz.semprec.app.presentation.CollectionViewModel
import cz.semprec.app.presentation.CollectionViewModelFactory
import cz.semprec.app.presentation.DetailViewModel
import cz.semprec.app.presentation.HomeViewModel
import cz.semprec.app.presentation.HomeViewModelFactory
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

/**
 * Native SDK and composition root of the screens. Its owner decides which screens share its data:
 * Apple owns one instance per window (the one `SharedScreenModelFactory` of each window's `AppComposition`),
 * Android one per process (the Koin `single` in `AppModule.kt`), which every `MainActivity` of the process shares.
 * State that must not be shared between windows or activities therefore does not belong in it. Every call creates
 * a new screen ViewModel that the caller owns: Android retains it in a `ViewModelStore`, SwiftUI releases it
 * through `close()` when the screen is gone.
 *
 * [sessionStorage] is where the signed-in session survives a restart (the Keychain on Apple); the default forgets
 * it with the process. [device] is recorded by the server at sign-in.
 */
class HomeSDK(
    sessionStorage: SessionStorage = InMemorySessionStorage(),
    device: DeviceInfo =
        DeviceInfo(AppPlatform.IOS, "00000000-0000-4000-8000-000000000000", "Device", "iphone", "0", "0"),
) {
    private val repository = InMemoryPlaceholderRepository()
    private val auth = HttpAuthRepository(ApiClient(), sessionStorage, device)
    private val viewModels =
        HomeViewModelFactory(LoadPlaceholderItems(repository), LoadPlaceholderItem(repository), auth)
    private val collectionReads = HttpCollectionReads(auth.api)

    /** The generic collection screens: any database's items, and one item of it. */
    val collections: CollectionSDK =
        CollectionSDK(CollectionViewModelFactory(collectionReads, HttpCollectionWrites(auth.api, collectionReads)))

    // The overview and its search; the recent searches live as long as this SDK, that is, as long as the window.
    private val overviewViewModels = OverviewViewModelFactory(
        LoadOverview(HttpOverviewRepository(auth.api)),
        SearchEverything(HttpSearchRepository(auth.api)),
        InMemoryRecentSearches(),
        auth,
    )

    // The task lists and the Podrobnosti sheet; a change made in the sheet reaches the open lists of the same window.
    private val work = WorkData(auth.api)
    private val workViewModels = WorkViewModelFactory(work.tasks, work.details, work.catalog, ItemChanges())

    /** The Tasks screen. [today] is `yyyy-MM-dd`, asked again whenever the screen groups its tasks. */
    fun tasksViewModel(today: () -> String, start: TasksStart): TasksViewModel =
        workViewModels.tasksViewModel(today, start)

    /** The Podrobnosti sheet of the task or event [itemId]. */
    fun itemDetailsViewModel(kind: ItemKind, itemId: String): ItemDetailsViewModel =
        workViewModels.itemDetailsViewModel(kind, itemId)

    fun homeViewModel(): HomeViewModel = viewModels.homeViewModel()

    fun overviewViewModel(): OverviewViewModel = overviewViewModels.overviewViewModel()

    fun searchViewModel(): SearchViewModel = overviewViewModels.searchViewModel()

    fun detailViewModel(itemId: String): DetailViewModel = viewModels.detailViewModel(itemId)

    fun settingsViewModel(): SettingsViewModel = viewModels.settingsViewModel()

    fun sessionViewModel(): SessionViewModel = viewModels.sessionViewModel()

    fun loginViewModel(): LoginViewModel = viewModels.loginViewModel()

    /** The diary and its subpages. */
    val journal: JournalSDK = JournalSDK(auth.api)

    /** The sleep plans, night exceptions and settings. */
    val sleep: SleepSDK = SleepSDK(auth.api)

    /** The calendar, its calendars list, its invitations and the new item form. */
    val calendar: CalendarSDK = CalendarSDK(auth.api)

    /** The assistant: the chat and its history, the status of Semp, runs, approvals, a project's agent and the bubble. */
    val semp: SempSDK = SempSDK(auth.api)
}

/** The screens of the generic collection engine; [HomeSDK.collections] hands it out. */
class CollectionSDK internal constructor(private val factory: CollectionViewModelFactory) {

    /** A collection of the items of one database that [target] selects. */
    fun collectionViewModel(target: CollectionTarget): CollectionViewModel = factory.collectionViewModel(target)

    /** The detail of one item; [databaseKeyHint] is the canonical key of its database, if the caller knows it. */
    fun itemViewModel(itemId: String, databaseKeyHint: String?): ItemViewModel =
        factory.itemViewModel(itemId, databaseKeyHint)
}
