package cz.semprec.app.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import cz.semprec.app.android.core.ui.R

/** A screen's loading, empty or error state, centered in the space the content would take. */
@Composable
fun StatusView(status: Status, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when (status) {
            Status.Loading -> {
                val description = stringResource(R.string.state_loading)
                CircularProgressIndicator(
                    Modifier.testTag(StatusTestTags.LOADING).semantics { contentDescription = description },
                )
            }
            is Status.Empty -> StatusMessage(status.message)
            is Status.Error -> {
                StatusMessage(status.message)
                Button(onClick = status.onRetry, modifier = Modifier.testTag(StatusTestTags.RETRY)) {
                    Text(stringResource(R.string.state_retry))
                }
            }
        }
    }
}

@Composable
private fun StatusMessage(message: String) {
    Text(
        text = message,
        modifier = Modifier.testTag(StatusTestTags.MESSAGE),
        style = MaterialTheme.typography.bodyLarge,
        textAlign = TextAlign.Center,
    )
}

@Preview(showBackground = true)
@Composable
private fun StatusViewLoadingPreview() {
    AppTheme { StatusView(Status.Loading) }
}
