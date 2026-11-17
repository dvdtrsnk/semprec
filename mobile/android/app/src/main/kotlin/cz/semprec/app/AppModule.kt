package cz.semprec.app

import cz.semprec.app.sdk.HomeSDK
import org.koin.core.module.dsl.viewModel
import org.koin.dsl.module

/**
 * One SDK for the process and the shared screen ViewModels it creates. `koinViewModel()` keeps each ViewModel
 * in the `ViewModelStore` of its navigation entry, which clears it when the entry leaves the back stack.
 */
val appModule = module {
    single { HomeSDK() }
    viewModel { get<HomeSDK>().homeViewModel() }
    viewModel { (itemId: String) -> get<HomeSDK>().detailViewModel(itemId) }
    viewModel { get<HomeSDK>().settingsViewModel() }
}
