package cz.semprec.app.feature.settings.presentation.components

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import cz.semprec.app.android.feature.settings.R
import cz.semprec.app.feature.settings.SettingsTestTags
import cz.semprec.app.presentation.SettingsRow

@Composable
internal fun SettingsRowItem(row: SettingsRow, onSelect: (SettingsRow) -> Unit, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { Text(stringResource(row.title)) },
        modifier = modifier.clickable { onSelect(row) }.testTag(row.testTag),
        leadingContent = { Icon(row.icon, contentDescription = null) },
    )
}

private val SettingsRow.title: Int
    @StringRes get() = when (this) {
        SettingsRow.ABOUT -> R.string.settings_row_about
    }

private val SettingsRow.icon: ImageVector
    get() = when (this) {
        SettingsRow.ABOUT -> Icons.Outlined.Info
    }

private val SettingsRow.testTag: String
    get() = when (this) {
        SettingsRow.ABOUT -> SettingsTestTags.ABOUT_ROW
    }
