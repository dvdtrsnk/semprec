package cz.semprec.app.feature.home.presentation.components

import androidx.compose.foundation.clickable
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import cz.semprec.app.android.feature.home.R
import cz.semprec.app.feature.home.HomeTestTags
import cz.semprec.app.presentation.HomeItem

@Composable
internal fun HomeListItem(item: HomeItem, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { Text(stringResource(R.string.home_item_title, item.ordinal)) },
        modifier = modifier.clickable { onSelect(item.id) }.testTag(HomeTestTags.HOME_ITEM_PREFIX + item.id),
    )
}
