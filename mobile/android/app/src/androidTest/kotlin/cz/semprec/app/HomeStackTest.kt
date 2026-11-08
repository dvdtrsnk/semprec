package cz.semprec.app

import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import cz.semprec.app.navigation.NavigationCommand
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** [AppSceneState.execute] on the real Home stack, which here replaces the scene MainActivity composes. */
@RunWith(AndroidJUnit4::class)
class HomeStackTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private lateinit var scene: AppSceneState

    @Before
    fun showTheHomeStack() {
        compose.runOnUiThread {
            compose.activity.setContent {
                val state = rememberAppSceneState()
                scene = state
                HomeTabHost(state.homeStack, UnusedRouter)
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun everyItemIdReachesTheDetailUnchanged() {
        val ids = listOf("item-1", "null", "a/b?c=%20 d&e#f", "%2F", "")
        ids.forEach { execute(NavigationCommand.Detail(it)) }

        val opened = ids.map {
            val top = topDetailId()
            execute(NavigationCommand.CloseDetail)
            top
        }
        assertEquals(ids.reversed(), opened)
        assertEquals(null, topDetailId())
    }

    private fun execute(command: NavigationCommand) {
        compose.runOnUiThread { compose.activity.lifecycleScope.launch { scene.execute(command) } }
        compose.waitForIdle()
    }

    /** The item id the top detail entry hands to its screen, or null when the list is on top. */
    private fun topDetailId(): String? = compose.runOnIdle {
        scene.homeStack.currentBackStackEntry
            ?.takeIf { it.destination.hasRoute<DetailRoute>() }
            ?.toRoute<DetailRoute>()
            ?.itemId
    }
}
