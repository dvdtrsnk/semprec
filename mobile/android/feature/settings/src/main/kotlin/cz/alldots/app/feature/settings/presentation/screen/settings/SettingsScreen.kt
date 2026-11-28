package cz.alldots.app.feature.settings.presentation.screen.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cz.alldots.app.core.ui.CollectEffects
import cz.alldots.app.feature.settings.SettingsRouter
import cz.alldots.app.feature.settings.handle
import cz.alldots.app.presentation.SettingsAction
import cz.alldots.app.presentation.SettingsViewModel

@Composable
fun SettingsScreen(viewModel: SettingsViewModel, router: SettingsRouter, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    CollectEffects(viewModel.effects, router::handle)
    SettingsScreenLayout(
        state = state,
        onSelectRow = { viewModel.onAction(SettingsAction.SelectRow(it)) },
        modifier = modifier,
    )
}
