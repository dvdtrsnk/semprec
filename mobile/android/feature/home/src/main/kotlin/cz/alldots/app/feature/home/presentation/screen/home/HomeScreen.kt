package cz.alldots.app.feature.home.presentation.screen.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cz.alldots.app.core.ui.CollectEffects
import cz.alldots.app.feature.home.HomeRouter
import cz.alldots.app.feature.home.handle
import cz.alldots.app.presentation.HomeAction
import cz.alldots.app.presentation.HomeViewModel

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
