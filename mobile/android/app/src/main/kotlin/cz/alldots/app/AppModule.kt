package cz.alldots.app

import cz.alldots.app.sdk.HomeSDK
import org.koin.android.ext.koin.androidContext
import org.koin.core.module.dsl.viewModel
import org.koin.dsl.module

/**
 * One SDK for the process, which keeps the mail thread lists in the app's cache directory, and the shared screen
 * ViewModels it creates. `koinViewModel()` keeps each ViewModel in the `ViewModelStore` of its navigation entry,
 * which clears it when the entry leaves the back stack.
 */
val appModule = module {
    single { HomeSDK(cacheDirectory = androidContext().cacheDir.path) }
    viewModel { get<HomeSDK>().homeViewModel() }
    viewModel { (itemId: String) -> get<HomeSDK>().detailViewModel(itemId) }
    viewModel { get<HomeSDK>().settingsViewModel() }
}
