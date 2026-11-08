package cz.semprec.app.feature.home.presentation.screen.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cz.semprec.app.feature.home.HomeRouter
import cz.semprec.app.presentation.DetailAction
import cz.semprec.app.presentation.DetailViewModel

/** The detail emits no effects (its effect type is `Nothing`), so only its state is collected. */
@Composable
fun DetailScreen(viewModel: DetailViewModel, router: HomeRouter, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    DetailScreenLayout(
        state = state,
        onRetry = { viewModel.onAction(DetailAction.Retry) },
        onBack = router::closeDetail,
        modifier = modifier,
    )
}
