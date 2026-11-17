package cz.semprec.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.SAVED_STATE_REGISTRY_OWNER_KEY
import androidx.lifecycle.VIEW_MODEL_STORE_OWNER_KEY
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.MutableCreationExtras
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cz.semprec.app.core.ui.AppTheme
import cz.semprec.app.navigation.SceneNavigation

/**
 * The exported launcher activity, which any app can start, or hand a new intent to, with whatever it puts into the
 * intent. The app defines no deep link, so nothing of such an intent may reach navigation: the activity exposes
 * only [withoutLaunchContent] copies of it.
 */
class MainActivity : ComponentActivity() {
    private val navigation: SceneNavigation by viewModels(
        // Only the owners the saved state handle is restored from, not the activity's default extras: those also
        // carry the extras of its intent as default arguments, and the queue must never depend on the intent.
        extrasProducer = {
            MutableCreationExtras().apply {
                set(SAVED_STATE_REGISTRY_OWNER_KEY, this@MainActivity)
                set(VIEW_MODEL_STORE_OWNER_KEY, this@MainActivity)
            }
        },
        factoryProducer = { viewModelFactory { initializer { SceneNavigation(createSavedStateHandle()) } } },
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        // Before anything reads it, on every creation: the system hands a recreated activity the original intent
        // again. Each tab's NavController reads Navigation's deep-link extras (NavController.KEY_DEEP_LINK_IDS,
        // KEY_DEEP_LINK_ARGS, KEY_DEEP_LINK_EXTRAS) from this intent when its NavHost sets the graph. It would
        // navigate to any destination they name, also without its arguments or with arguments of another type,
        // which crashes the app.
        intent = intent.withoutLaunchContent()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AppTheme { AppScene(navigation) } }
    }

    /**
     * Hands the new intent on without its launch content. Reachable whatever the launch mode: a caller's
     * FLAG_ACTIVITY_SINGLE_TOP, for one, delivers its intent to this activity while it is on top of its task.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent.withoutLaunchContent())
    }
}

/**
 * A copy with the parts [Intent.filterEquals] compares, except the data and its type: action, categories, component,
 * package and identifier. Nothing else the sender chose is kept, no extras, data, clip data, selector or flags. A
 * deep link the app adds later has to be read from the original intent here, and checked, on purpose.
 */
private fun Intent.withoutLaunchContent(): Intent = cloneFilter().apply { data = null }
