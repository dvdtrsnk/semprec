package cz.semprec.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelProvider
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cz.semprec.app.core.ui.StatusTestTags
import cz.semprec.app.feature.home.HomeRouter
import cz.semprec.app.feature.home.HomeTestTags
import cz.semprec.app.feature.settings.SettingsTestTags
import cz.semprec.app.navigation.SceneNavigation
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import cz.semprec.app.android.feature.home.R as HomeR
import cz.semprec.app.android.feature.settings.R as SettingsR

/** The placeholder app end to end, on the real shared SDK and the app's navigation. */
@RunWith(AndroidJUnit4::class)
class SmokeFlowTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun itemTitle(ordinal: Int): String = context.getString(HomeR.string.home_item_title, ordinal)

    /** Calls the app's Home router on the main thread, as the Home screen does. */
    private fun withHomeRouter(calls: HomeRouter.() -> Unit) = compose.activityRule.scenario.onActivity { activity ->
        ViewModelProvider(activity)[SceneNavigation::class.java].home.calls()
    }

    @Test
    fun homeListOpensTheDetailAndBackReturnsToTheList() {
        compose.onNodeWithTag(HomeTestTags.HOME_ITEM_PREFIX + "item-2").performClick()
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(2))
        compose.onNodeWithTag(HomeTestTags.DETAIL_BACK).performClick()
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()

        compose.onNodeWithTag(HomeTestTags.HOME_ITEM_PREFIX + "item-1").performClick()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(1))
        // The detail survived the recreation; one system back returns to the list.
        Espresso.pressBack()
        compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
    }

    @Test
    fun settingsAboutRowPresentsTheAboutSheetWithTheAppVersionAndDoneDismissesIt() {
        compose.onNodeWithTag(AppTestTags.SETTINGS_TAB).performClick()
        compose.onNodeWithTag(SettingsTestTags.ABOUT_ROW).performClick()
        compose.onNodeWithTag(SettingsTestTags.ABOUT_SCREEN).assertIsDisplayed()
        val versionLine =
            context.getString(SettingsR.string.about_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
        compose.onNodeWithText(versionLine).assertIsDisplayed()
        compose.onNodeWithTag(SettingsTestTags.ABOUT_DONE).performClick()
        compose.onNodeWithTag(SettingsTestTags.ABOUT_SCREEN).assertDoesNotExist()
        compose.onNodeWithTag(SettingsTestTags.SETTINGS_SCREEN).assertIsDisplayed()
    }

    @Test
    fun aHomeCommandRightAfterRecreationOnSettingsWaitsForTheHomeStackAndRuns() {
        compose.onNodeWithTag(AppTestTags.SETTINGS_TAB).performClick()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag(SettingsTestTags.SETTINGS_SCREEN).assertIsDisplayed()

        // The recreated Home controller has no graph until the Home tab is shown again.
        withHomeRouter { showDetail("item-3") }
        compose.onNodeWithTag(AppTestTags.HOME_TAB).assertIsSelected()
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(3))
        Espresso.pressBack()
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
    }

    @Test
    fun aDetailOpenedOverTheDetailOfAnotherItemShowsItsOwnItemAndBackReturnsToTheFirst() {
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        withHomeRouter { showDetail("item-1") }
        // The first detail is shown, so its entry already holds the ViewModel of item-1.
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(1))
        withHomeRouter { showDetail("item-2") }
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(2))
        Espresso.pressBack()
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(1))
        Espresso.pressBack()
        compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
    }

    @Test
    fun aSecondDetailOfTheItemAlreadyOnTopIsNotPushedAgain() {
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        // Both commands are queued before the scene runs the first, as after a two-finger tap on one row.
        withHomeRouter {
            showDetail("item-3")
            showDetail("item-3")
        }
        compose.onNodeWithTag(HomeTestTags.DETAIL_TITLE).assertTextEquals(itemTitle(3))
        Espresso.pressBack()
        compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertDoesNotExist()
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
    }

    @Test
    fun aDetailOpensForAnItemIdThatIsTheWordNullOrHoldsRouteCharacters() {
        compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        val notFound = context.getString(HomeR.string.detail_notFound)
        listOf("null", "a/b?c=%20 d&e#f", "").forEach { id ->
            withHomeRouter { showDetail(id) }
            compose.onNodeWithTag(HomeTestTags.DETAIL_SCREEN).assertIsDisplayed()
            // No list item has such an id, so the shared detail reports it as not found.
            compose.onNodeWithTag(StatusTestTags.MESSAGE).assertTextEquals(notFound)
            Espresso.pressBack()
            compose.onNodeWithTag(HomeTestTags.HOME_SCREEN).assertIsDisplayed()
        }
    }
}
