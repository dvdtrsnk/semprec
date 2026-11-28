package cz.alldots.app

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import cz.alldots.app.feature.settings.SettingsRouter
import cz.alldots.app.feature.settings.presentation.screen.settings.SettingsScreen
import cz.alldots.app.presentation.SettingsViewModel
import org.koin.androidx.compose.koinViewModel

@Composable
fun SettingsTabHost(stack: NavHostController, router: SettingsRouter, modifier: Modifier = Modifier) {
    NavHost(stack, startDestination = SettingsRoute, modifier = modifier) {
        composable<SettingsRoute> {
            SettingsScreen(koinViewModel<SettingsViewModel>(), router)
        }
    }
}
