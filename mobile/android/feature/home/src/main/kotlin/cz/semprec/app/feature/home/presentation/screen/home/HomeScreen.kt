package cz.semprec.app.feature.home.presentation.screen.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cz.semprec.app.core.ui.CollectEffects
import cz.semprec.app.feature.home.HomeRouter
import cz.semprec.app.feature.home.handle
import cz.semprec.app.presentation.HomeAction
import cz.semprec.app.presentation.HomeViewModel

@Composable
fun HomeScreen(viewModel: HomeViewModel, router: HomeRouter, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    CollectEffects(viewModel.effects, router::handle)
    HomeScreenLayout(
        state = state,
        onRetry = { viewModel.onAction(HomeAction.Retry) },
        onSelectItem = { viewModel.onAction(HomeAction.SelectItem(it)) },
        modifier = modifier,
    )
}
