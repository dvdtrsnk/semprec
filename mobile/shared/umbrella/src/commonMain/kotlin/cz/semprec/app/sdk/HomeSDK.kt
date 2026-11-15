package cz.semprec.app.sdk

import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.HttpAuthRepository
import cz.semprec.app.data.HttpCollectionReads
import cz.semprec.app.data.HttpCollectionWrites
import cz.semprec.app.data.InMemoryPlaceholderRepository
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.presentation.CollectionViewModel
import cz.semprec.app.presentation.CollectionViewModelFactory
import cz.semprec.app.presentation.DetailViewModel
import cz.semprec.app.presentation.HomeViewModel
import cz.semprec.app.presentation.HomeViewModelFactory
import cz.semprec.app.presentation.ItemViewModel
import cz.semprec.app.presentation.LoginViewModel
import cz.semprec.app.presentation.SessionViewModel
import cz.semprec.app.presentation.SettingsViewModel

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
    private val collections = CollectionViewModelFactory(collectionReads, HttpCollectionWrites(auth.api, collectionReads))

    fun homeViewModel(): HomeViewModel = viewModels.homeViewModel()

    fun detailViewModel(itemId: String): DetailViewModel = viewModels.detailViewModel(itemId)

    fun settingsViewModel(): SettingsViewModel = viewModels.settingsViewModel()

    fun sessionViewModel(): SessionViewModel = viewModels.sessionViewModel()

    fun loginViewModel(): LoginViewModel = viewModels.loginViewModel()

    /**
     * A collection of the items of one database, named by its canonical [databaseKey] or its [databaseId]. At most
     * one narrowing applies, the first given of [areaId], [relationKey] with [relatedItemId], and [filterJson].
     */
    fun collectionViewModel(
        databaseKey: String?,
        databaseId: String?,
        areaId: String?,
        relationKey: String?,
        relatedItemId: String?,
        filterJson: String?,
    ): CollectionViewModel =
        collections.collectionViewModel(databaseKey, databaseId, areaId, relationKey, relatedItemId, filterJson)

    /** The detail of one item; [databaseKeyHint] is the canonical key of its database, if the caller knows it. */
    fun itemViewModel(itemId: String, databaseKeyHint: String?): ItemViewModel =
        collections.itemViewModel(itemId, databaseKeyHint)
}
