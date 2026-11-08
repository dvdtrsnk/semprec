package cz.semprec.app

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import cz.semprec.app.feature.settings.SettingsRouter
import cz.semprec.app.feature.settings.presentation.screen.settings.SettingsScreen
import cz.semprec.app.presentation.SettingsViewModel
import org.koin.androidx.compose.koinViewModel

@Composable
fun SettingsTabHost(stack: NavHostController, router: SettingsRouter, modifier: Modifier = Modifier) {
    NavHost(stack, startDestination = SettingsRoute, modifier = modifier) {
        composable<SettingsRoute> {
            SettingsScreen(koinViewModel<SettingsViewModel>(), router)
        }
    }
}
