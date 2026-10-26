package cz.semprec.app.components

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import cz.semprec.app.AppTab
import cz.semprec.app.AppTestTags
import cz.semprec.app.R
import cz.semprec.app.core.ui.AppTheme

@Composable
fun AppBottomBar(selectedTab: AppTab, onSelectTab: (AppTab) -> Unit, modifier: Modifier = Modifier) {
    NavigationBar(modifier) {
        AppTab.entries.forEach { tab ->
            NavigationBarItem(
                selected = tab == selectedTab,
                onClick = { onSelectTab(tab) },
                icon = { Icon(tab.icon, contentDescription = null) },
                modifier = Modifier.testTag(tab.testTag),
                label = { Text(stringResource(tab.label)) },
            )
        }
    }
}

private val AppTab.label: Int
    @StringRes get() = when (this) {
        AppTab.HOME -> R.string.tab_home
        AppTab.SETTINGS -> R.string.tab_settings
    }

private val AppTab.icon: ImageVector
    get() = when (this) {
        AppTab.HOME -> Icons.Filled.Home
        AppTab.SETTINGS -> Icons.Filled.Settings
    }

private val AppTab.testTag: String
    get() = when (this) {
        AppTab.HOME -> AppTestTags.HOME_TAB
        AppTab.SETTINGS -> AppTestTags.SETTINGS_TAB
    }

@Preview
@Composable
private fun AppBottomBarPreview() {
    AppTheme { AppBottomBar(selectedTab = AppTab.HOME, onSelectTab = {}) }
}
