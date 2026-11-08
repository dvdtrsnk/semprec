package cz.semprec.app.sdk

import cz.semprec.app.data.InMemoryPlaceholderRepository
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.presentation.DetailViewModel
import cz.semprec.app.presentation.HomeViewModel
import cz.semprec.app.presentation.HomeViewModelFactory
import cz.semprec.app.presentation.SettingsViewModel

/**
 * Native SDK and composition root of the placeholder screens. Its owner decides which screens share its data:
 * Apple owns one instance per window (the one `SharedScreenModelFactory` of each window's `AppComposition`),
 * Android one per process (the Koin `single` in `AppModule.kt`), which every `MainActivity` of the process shares.
 * State that must not be shared between windows or activities therefore does not belong in it. Every call creates
 * a new screen ViewModel that the caller owns: Android retains it in a `ViewModelStore`, SwiftUI releases it
 * through `close()` when the screen is gone.
 */
class HomeSDK {
    private val repository = InMemoryPlaceholderRepository()
    private val viewModels = HomeViewModelFactory(LoadPlaceholderItems(repository), LoadPlaceholderItem(repository))

    fun homeViewModel(): HomeViewModel = viewModels.homeViewModel()

    fun detailViewModel(itemId: String): DetailViewModel = viewModels.detailViewModel(itemId)

    fun settingsViewModel(): SettingsViewModel = viewModels.settingsViewModel()
}
