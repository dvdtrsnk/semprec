package cz.semprec.app.feature.settings.presentation.screen.settings

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
import cz.semprec.app.android.feature.settings.R
import cz.semprec.app.core.ui.AppTheme
import cz.semprec.app.feature.settings.SettingsTestTags
import cz.semprec.app.feature.settings.presentation.components.SettingsRowItem
import cz.semprec.app.presentation.SettingsRow
import cz.semprec.app.presentation.SettingsState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreenLayout(state: SettingsState, onSelectRow: (SettingsRow) -> Unit, modifier: Modifier = Modifier) {
    Scaffold(
        modifier = modifier.testTag(SettingsTestTags.SETTINGS_SCREEN),
        topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            items(state.rows, key = { it.name }) { row -> SettingsRowItem(row, onSelect = onSelectRow) }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SettingsScreenLayoutPreview() {
    AppTheme { SettingsScreenLayout(state = SettingsState(), onSelectRow = {}) }
}
