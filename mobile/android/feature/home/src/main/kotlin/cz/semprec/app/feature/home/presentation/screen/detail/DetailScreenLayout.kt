package cz.semprec.app.feature.home.presentation.screen.detail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import cz.semprec.app.android.feature.home.R
import cz.semprec.app.core.ui.AppTheme
import cz.semprec.app.core.ui.Status
import cz.semprec.app.core.ui.StatusView
import cz.semprec.app.feature.home.HomeTestTags
import cz.semprec.app.feature.home.presentation.failureMessage
import cz.semprec.app.presentation.DetailPhase
import cz.semprec.app.presentation.DetailState
import cz.semprec.app.presentation.HomeItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreenLayout(
    state: DetailState,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier.testTag(HomeTestTags.DETAIL_SCREEN),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.detail_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag(HomeTestTags.DETAIL_BACK)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.detail_back))
                    }
                },
            )
        },
    ) { padding ->
        val contentModifier = Modifier.padding(padding)
        when (state.phase) {
            DetailPhase.LOADING -> StatusView(Status.Loading, contentModifier)
            DetailPhase.NOT_FOUND -> StatusView(Status.Empty(stringResource(R.string.detail_notFound)), contentModifier)
            DetailPhase.ERROR -> StatusView(
                Status.Error(stringResource(failureMessage(state.failure)), onRetry),
                contentModifier,
            )
            DetailPhase.CONTENT -> state.item?.let { DetailContent(it, contentModifier) }
        }
    }
}

@Composable
private fun DetailContent(item: HomeItem, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringResource(R.string.home_item_title, item.ordinal),
            modifier = Modifier.testTag(HomeTestTags.DETAIL_TITLE),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(stringResource(R.string.detail_description), style = MaterialTheme.typography.bodyLarge)
    }
}

@Preview(showBackground = true)
@Composable
private fun DetailScreenLayoutContentPreview() {
    AppTheme {
        DetailScreenLayout(
            state = DetailState(DetailPhase.CONTENT, HomeItem(id = "item-1", ordinal = 1)),
            onRetry = {},
            onBack = {},
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun DetailScreenLayoutNotFoundPreview() {
    AppTheme { DetailScreenLayout(state = DetailState(DetailPhase.NOT_FOUND), onRetry = {}, onBack = {}) }
}
