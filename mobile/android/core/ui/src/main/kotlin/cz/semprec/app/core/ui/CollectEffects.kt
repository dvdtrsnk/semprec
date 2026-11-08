package cz.semprec.app.core.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext

/**
 * Delivers one-time ViewModel effects to [onEffect] while the screen is at least STARTED, in the order they were
 * emitted. Effects emitted while the screen is stopped stay buffered in the ViewModel and are delivered on the
 * next start. Each effect emitted on the main thread is delivered exactly once while the ViewModel lives (see
 * [collectWhileStarted]).
 */
@Composable
fun <T> CollectEffects(effects: Flow<T>, onEffect: (T) -> Unit) {
    val current by rememberUpdatedState(onEffect)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(effects, lifecycle) { lifecycle.collectWhileStarted(effects) { current(it) } }
}

/**
 * Collects [effects] into [onEffect] while this lifecycle is at least STARTED, until the caller is cancelled.
 *
 * The collection runs on `Dispatchers.Main.immediate`. A channel hands an effect to a waiting collector and the
 * collector resumes later on its dispatcher; a collector cancelled in between drops that effect for good. On an
 * always-dispatching context, such as Compose's, that resume waits behind every message already queued on the
 * main looper, an ON_STOP included. On `Main.immediate` an effect emitted on the main thread resumes the collector
 * inside the emitting call, before the looper can run anything else, so no lifecycle event can come in between.
 */
internal suspend fun <T> Lifecycle.collectWhileStarted(effects: Flow<T>, onEffect: (T) -> Unit) {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        withContext(Dispatchers.Main.immediate) { effects.collect { onEffect(it) } }
    }
}
