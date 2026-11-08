package cz.semprec.app

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import cz.semprec.app.feature.home.HomeRouter
import cz.semprec.app.feature.home.presentation.screen.detail.DetailScreen
import cz.semprec.app.feature.home.presentation.screen.home.HomeScreen
import cz.semprec.app.presentation.DetailViewModel
import cz.semprec.app.presentation.HomeViewModel
import org.koin.androidx.compose.koinViewModel
import org.koin.core.parameter.parametersOf

@Composable
fun HomeTabHost(stack: NavHostController, router: HomeRouter, modifier: Modifier = Modifier) {
    NavHost(stack, startDestination = HomeRoute, modifier = modifier) {
        composable<HomeRoute> {
            HomeScreen(koinViewModel<HomeViewModel>(), router)
        }
        composable<DetailRoute> { entry ->
            // AppSceneState opens each detail as a new entry, never with launchSingleTop, which would hand the top
            // entry's ViewModelStore to the next detail. So this ViewModel is always the one built for this itemId.
            val itemId = entry.toRoute<DetailRoute>().itemId
            DetailScreen(koinViewModel<DetailViewModel>(parameters = { parametersOf(itemId) }), router)
        }
    }
}
