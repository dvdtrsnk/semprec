package cz.alldots.app.feature.home.presentation.screen.home

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import cz.alldots.app.android.feature.home.R
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.ui.AppTheme
import cz.alldots.app.core.ui.Status
import cz.alldots.app.core.ui.StatusView
import cz.alldots.app.feature.home.HomeTestTags
import cz.alldots.app.feature.home.presentation.components.HomeListItem
import cz.alldots.app.feature.home.presentation.failureMessage
import cz.alldots.app.presentation.HomeItem
import cz.alldots.app.presentation.HomePhase
import cz.alldots.app.presentation.HomeState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreenLayout(
    state: HomeState,
    onRetry: () -> Unit,
    onSelectItem: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier.testTag(HomeTestTags.HOME_SCREEN),
        topBar = { TopAppBar(title = { Text(stringResource(R.string.home_title)) }) },
    ) { padding ->
        val contentModifier = Modifier.padding(padding)
        when (state.phase) {
            HomePhase.LOADING -> StatusView(Status.Loading, contentModifier)
            HomePhase.EMPTY -> StatusView(Status.Empty(stringResource(R.string.home_empty)), contentModifier)
            HomePhase.ERROR -> StatusView(
                Status.Error(stringResource(failureMessage(state.failure)), onRetry),
                contentModifier,
            )
            HomePhase.CONTENT -> LazyColumn(contentModifier.fillMaxSize()) {
                items(state.items, key = { it.id }) { item -> HomeListItem(item, onSelect = onSelectItem) }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun HomeScreenLayoutContentPreview() {
    AppTheme {
        HomeScreenLayout(
            state = HomeState(HomePhase.CONTENT, List(3) { HomeItem(id = "item-${it + 1}", ordinal = it + 1) }),
            onRetry = {},
            onSelectItem = {},
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun HomeScreenLayoutEmptyPreview() {
    AppTheme { HomeScreenLayout(state = HomeState(HomePhase.EMPTY), onRetry = {}, onSelectItem = {}) }
}

@Preview(showBackground = true)
@Composable
private fun HomeScreenLayoutErrorPreview() {
    AppTheme {
        HomeScreenLayout(
            state = HomeState(HomePhase.ERROR, failure = FailureKind.UNAVAILABLE),
            onRetry = {},
            onSelectItem = {},
        )
    }
}
