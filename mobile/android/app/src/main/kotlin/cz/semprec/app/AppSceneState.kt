package cz.semprec.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import cz.semprec.app.navigation.NavigationCommand
import kotlinx.coroutines.flow.first

/** Scene UI state: the selected tab, the presented sheet and one navigation stack per tab. */
@Stable
class AppSceneState(
    val homeStack: NavHostController,
    val settingsStack: NavHostController,
    selectedTab: MutableState<AppTab>,
    aboutVisible: MutableState<Boolean>,
) {
    var selectedTab by selectedTab
    var aboutVisible by aboutVisible

    /**
     * Executes one queued navigation command against the app-owned controllers. A command for the Home stack
     * selects the Home tab and suspends until the tab's NavHost has set the graph: a scene recreated with Settings
     * selected has a Home controller without a graph, and without its restored back stack, until Home is shown.
     * Nothing suspends after the command took effect, so the caller can acknowledge it right after this returns.
     */
    suspend fun execute(command: NavigationCommand) {
        when (command) {
            is NavigationCommand.Detail -> {
                showHomeStack()
                // Each detail is a new entry whose ViewModel is built for its own id (launchSingleTop would replace
                // the top detail but keep its ViewModel). Only the detail of the same id already on top, as after a
                // second tap that arrived with the first, is not pushed again.
                if (topDetailId() != command.id) homeStack.navigate(DetailRoute(command.id))
            }
            NavigationCommand.CloseDetail -> {
                showHomeStack()
                // Pops the top detail only, so a repeated close (a second tap during the exit animation) keeps the
                // list.
                homeStack.popBackStack<DetailRoute>(inclusive = true)
            }
            NavigationCommand.About -> aboutVisible = true
        }
    }

    private suspend fun showHomeStack() {
        selectedTab = AppTab.HOME
        // The controller emits its current entry once the graph is set (replayed to later collectors).
        homeStack.currentBackStackEntryFlow.first()
    }

    /** The item id of the detail on top of the Home stack, or null when the top entry is no detail. */
    private fun topDetailId(): String? = homeStack.currentBackStackEntry
        ?.takeIf { it.destination.hasRoute<DetailRoute>() }
        ?.toRoute<DetailRoute>()
        ?.itemId
}

/** The scene state of this composition; the tab and the sheet survive recreation and process death. */
@Composable
fun rememberAppSceneState(): AppSceneState {
    val homeStack = rememberNavController()
    val settingsStack = rememberNavController()
    val selectedTab = rememberSaveable { mutableStateOf(AppTab.HOME) }
    val aboutVisible = rememberSaveable { mutableStateOf(false) }
    return remember(homeStack, settingsStack, selectedTab, aboutVisible) {
        AppSceneState(homeStack, settingsStack, selectedTab, aboutVisible)
    }
}
