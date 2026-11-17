package cz.semprec.app.components

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import cz.semprec.app.BuildConfig
import cz.semprec.app.feature.settings.presentation.screen.about.AboutScreenLayout
import kotlinx.coroutines.launch

/**
 * Presents the About layout of the Settings feature as a modal bottom sheet, with the version name and code
 * of this build; [onDismiss] removes it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutSheet(onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    // The sheet is a window of its own, outside the scene's semantics tree.
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = modifier.semantics { testTagsAsResourceId = true },
        sheetState = sheetState,
    ) {
        AboutScreenLayout(
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            onDone = {
                scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) onDismiss() }
            },
            modifier = Modifier.padding(bottom = 24.dp),
        )
    }
}
