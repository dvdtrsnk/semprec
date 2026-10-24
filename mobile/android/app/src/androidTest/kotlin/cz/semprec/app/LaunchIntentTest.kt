package cz.semprec.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.core.os.bundleOf
import androidx.core.util.Consumer
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.navigation.NavController
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cz.semprec.app.feature.home.HomeTestTags
import cz.semprec.app.navigation.SceneNavigation
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import cz.semprec.app.android.feature.home.R as HomeR

/**
 * What another app can put into the intent that starts the exported MainActivity, or delivers to the running one:
 * extras named like the saved navigation state, Navigation's own deep-link extras and a data URI. None of it
 * navigates or crashes the app, and the activity hands none of it on.
 */
@RunWith(AndroidJUnit4::class)
class LaunchIntentTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test
    fun extrasNamedLikeTheSavedNavigationStateDoNotNavigate() {
        val intent = Intent(context, MainActivity::class.java)
            .putStringArrayListExtra(SceneNavigation.PENDING_KEY, arrayListOf("1|detail:item-2"))
            .putExtra(SceneNavigation.NEXT_SEQUENCE_KEY, "1")
        ActivityScenario.launch<MainActivity>(intent).use {
            compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
            compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()

            // The app's own navigation still works.
            compose.onNodeWithTag(HomeTestTags.HOME_ITEM_PREFIX + "item-1").performClick()
            compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE)
                .assertTextEquals(context.getString(HomeR.string.home_item_title, 1))
        }
    }

    @Test
    fun navigationDeepLinkIdsToTheDetailWithoutArgumentsShowTheList() {
        launchAndAssertTheListShows(deepLinkToTheDetail(readHomeGraph()))
    }

    @Test
    fun navigationDeepLinkIdsToTheDetailWithAnItemIdShowTheList() {
        val home = readHomeGraph()
        launchAndAssertTheListShows(deepLinkToTheDetail(home, Bundle(), bundleOf(home.itemIdArgument to "item-2")))
    }

    @Test
    fun navigationDeepLinkIdsToTheDetailWithoutTheItemIdShowTheList() {
        launchAndAssertTheListShows(deepLinkToTheDetail(readHomeGraph(), Bundle(), Bundle()))
    }

    @Test
    fun navigationDeepLinkIdsToTheDetailWithAnItemIdOfAnotherTypeShowTheList() {
        val home = readHomeGraph()
        launchAndAssertTheListShows(deepLinkToTheDetail(home, Bundle(), bundleOf(home.itemIdArgument to 2)))
    }

    @Test
    fun navigationDeepLinkExtrasWithAnItemIdShowTheList() {
        val home = readHomeGraph()
        val intent = deepLinkToTheDetail(home)
            .putExtra(NavController.KEY_DEEP_LINK_EXTRAS, bundleOf(home.itemIdArgument to "item-2"))
        launchAndAssertTheListShows(intent)
    }

    @Test
    fun aNewTaskLaunchWithNavigationDeepLinkIdsShowsTheList() {
        // FLAG_ACTIVITY_NEW_TASK without FLAG_ACTIVITY_CLEAR_TASK, as `adb shell am start` sends it, for which
        // Navigation would restart the task to follow the deep link.
        val home = readHomeGraph()
        startInNewTask(deepLinkToTheDetail(home, Bundle(), bundleOf(home.itemIdArgument to "item-2"))) { activity ->
            assertShowsTheListOnly()
            assertCarriesNoLaunchContent(activity.intent)
        }
    }

    @Test
    fun aDataUriShowsTheListAndIsNotHandedOn() {
        // The graphs declare no deep link, so Navigation has nothing to match the URI against today. The activity
        // drops it all the same, so a deep link added to a graph later is not followed from an unchecked launch.
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(FOREIGN_URI), context, MainActivity::class.java)
        startInNewTask(intent) { activity ->
            assertShowsTheListOnly()
            assertCarriesNoLaunchContent(activity.intent)
        }
    }

    @Test
    fun anIntentDeliveredToTheRunningActivityIsHandedOnWithoutItsContent() {
        val home = readHomeGraph()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val delivered = LinkedBlockingQueue<Intent>()
            scenario.onActivity { it.addOnNewIntentListener(Consumer { intent -> delivered.add(intent) }) }

            // FLAG_ACTIVITY_SINGLE_TOP delivers the intent to the running activity, whatever its launch mode.
            val foreign = deepLinkToTheDetail(home, Bundle(), bundleOf(home.itemIdArgument to "item-2"))
                .setData(Uri.parse(FOREIGN_URI))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            context.startActivity(foreign)

            assertCarriesNoLaunchContent(
                checkNotNull(delivered.poll(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "No new intent was delivered." },
            )
            assertShowsTheListOnly()
            scenario.onActivity { assertCarriesNoLaunchContent(it.intent) }
        }
    }

    /** Navigation's ids of the Home graph and of its DetailRoute destination, and the name of the item id. */
    private class HomeGraph(val graphId: Int, val detailId: Int, val itemIdArgument: String)

    /** Reads [HomeGraph] from the graph the app's Home stack builds, so no id is copied into the test. */
    private fun readHomeGraph(): HomeGraph = ActivityScenario.launch(MainActivity::class.java).use { scenario ->
        lateinit var stack: NavHostController
        scenario.onActivity { activity ->
            activity.setContent {
                stack = rememberNavController()
                HomeTabHost(stack, UnusedRouter)
            }
        }
        compose.runOnIdle {
            val detail = checkNotNull(stack.graph.findNode<DetailRoute>()) { "The Home graph has no DetailRoute." }
            HomeGraph(stack.graph.id, detail.id, detail.arguments.keys.single())
        }
    }

    /**
     * An intent to MainActivity with Navigation's deep-link extras from the Home graph to its detail, and with
     * [arguments], one bundle per id, when given.
     */
    private fun deepLinkToTheDetail(home: HomeGraph, vararg arguments: Bundle): Intent =
        Intent(context, MainActivity::class.java)
            .putExtra(NavController.KEY_DEEP_LINK_IDS, intArrayOf(home.graphId, home.detailId))
            .apply {
                if (arguments.isNotEmpty()) {
                    putParcelableArrayListExtra(NavController.KEY_DEEP_LINK_ARGS, arrayListOf(*arguments))
                }
            }

    /**
     * Launches MainActivity with [intent], which ActivityScenario sends with FLAG_ACTIVITY_NEW_TASK and
     * FLAG_ACTIVITY_CLEAR_TASK added, and checks that the list shows and the activity exposes nothing of the intent.
     */
    private fun launchAndAssertTheListShows(intent: Intent) = ActivityScenario.launch<MainActivity>(intent).use {
        assertShowsTheListOnly()
        it.onActivity { activity -> assertCarriesNoLaunchContent(activity.intent) }
    }

    /**
     * Starts MainActivity with [intent] in a new task, runs [checks] and finishes the activity. Unlike
     * ActivityScenario, this neither adds FLAG_ACTIVITY_CLEAR_TASK nor needs the started activity's intent to keep
     * the data of [intent].
     */
    private fun startInNewTask(intent: Intent, checks: (Activity) -> Unit) {
        val activity = instrumentation.startActivitySync(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            checks(activity)
        } finally {
            finishAndAwaitDestruction(activity as ComponentActivity)
        }
    }

    private fun finishAndAwaitDestruction(activity: ComponentActivity) {
        val destroyed = CountDownLatch(1)
        instrumentation.runOnMainSync {
            if (activity.lifecycle.currentState == Lifecycle.State.DESTROYED) {
                destroyed.countDown()
            } else {
                activity.lifecycle.addObserver(
                    LifecycleEventObserver { _, event ->
                        if (event == Lifecycle.Event.ON_DESTROY) destroyed.countDown()
                    },
                )
                activity.finish()
            }
        }
        check(destroyed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { "MainActivity was not destroyed." }
    }

    private fun assertShowsTheListOnly() {
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()
    }

    private fun assertCarriesNoLaunchContent(intent: Intent) {
        assertTrue("The intent still carries extras: ${intent.extras}", intent.extras?.isEmpty ?: true)
        assertNull(intent.data)
        assertNull(intent.type)
        assertNull(intent.clipData)
    }

    private companion object {
        const val TIMEOUT_SECONDS = 10L
        const val FOREIGN_URI = "semprec://home/detail/item-2"
    }
}
