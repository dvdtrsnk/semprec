package cz.semprec.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import cz.semprec.app.components.AboutSheet
import cz.semprec.app.components.AppBottomBar
import cz.semprec.app.navigation.SceneNavigation

/**
 * The tabs, their navigation stacks and the About sheet. Navigation commands run one at a time, only while the
 * scene is STARTED, and are acknowledged after they ran, so each runs once, also across recreation; a command
 * interrupted while it waits for its tab stays queued and runs on the next start.
 */
@Composable
fun AppScene(navigation: SceneNavigation, modifier: Modifier = Modifier) {
    val state = rememberAppSceneState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(navigation, state, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            navigation.commands.collect { queued ->
                state.execute(queued.command)
                navigation.acknowledge(queued.sequence)
            }
        }
    }
    // Keeps the remembered UI state of each tab, such as list scroll positions, across tab switches.
    val tabs = rememberSaveableStateHolder()

    Scaffold(
        modifier = modifier.semantics { testTagsAsResourceId = true },
        bottomBar = { AppBottomBar(state.selectedTab, onSelectTab = { state.selectedTab = it }) },
    ) { padding ->
        // Back on the Settings root returns to Home. A tab's NavHost registers its handler later and so pops
        // its own stack first.
        BackHandler(enabled = state.selectedTab != AppTab.HOME) { state.selectedTab = AppTab.HOME }
        val hostModifier = Modifier.padding(padding).consumeWindowInsets(padding)
        tabs.SaveableStateProvider(state.selectedTab) {
            when (state.selectedTab) {
                AppTab.HOME -> HomeTabHost(state.homeStack, navigation.home, hostModifier)
                AppTab.SETTINGS -> SettingsTabHost(state.settingsStack, navigation.settings, hostModifier)
            }
        }
        if (state.aboutVisible) AboutSheet(onDismiss = { state.aboutVisible = false })
    }
}
