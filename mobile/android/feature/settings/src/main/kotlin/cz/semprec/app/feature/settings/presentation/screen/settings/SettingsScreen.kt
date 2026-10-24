package cz.semprec.app.feature.settings.presentation.screen.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cz.semprec.app.core.ui.CollectEffects
import cz.semprec.app.feature.settings.SettingsRouter
import cz.semprec.app.feature.settings.handle
import cz.semprec.app.presentation.SettingsAction
import cz.semprec.app.presentation.SettingsViewModel

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
