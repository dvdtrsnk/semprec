package cz.semprec.app.feature.settings.presentation.screen.about

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import cz.semprec.app.android.feature.settings.R
import cz.semprec.app.core.ui.AppTheme
import cz.semprec.app.feature.settings.SettingsTestTags

/**
 * Information about the app. It has no shared ViewModel, so there is no `AboutScreen`; the app presents this
 * layout (as a bottom sheet), passes in its own [versionName] and [versionCode], and passes [onDone] to dismiss it.
 */
@Composable
fun AboutScreenLayout(versionName: String, versionCode: Int, onDone: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().testTag(SettingsTestTags.ABOUT_SCREEN).padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.about_title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.about_description), style = MaterialTheme.typography.bodyLarge)
        Text(
            text = stringResource(R.string.about_version, versionName, versionCode),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(
            onClick = onDone,
            modifier = Modifier.align(Alignment.End).testTag(SettingsTestTags.ABOUT_DONE),
        ) {
            Text(stringResource(R.string.about_done))
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AboutScreenLayoutPreview() {
    AppTheme { AboutScreenLayout(versionName = "0.1.0", versionCode = 1, onDone = {}) }
}
