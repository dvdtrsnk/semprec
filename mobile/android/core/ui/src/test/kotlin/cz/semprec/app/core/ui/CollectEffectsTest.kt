package cz.semprec.app.core.ui

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.MainCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import kotlin.coroutines.CoroutineContext

@OptIn(ExperimentalCoroutinesApi::class)
class CollectEffectsTest {
    private val looper = MainLooper()
    private val owner = TestLifecycleOwner()

    // The channel a ScreenViewModel delivers its effects through.
    private val effects = Channel<String>(Channel.UNLIMITED)
    private val delivered = mutableListOf<String>()

    // Compose runs a LaunchedEffect on a dispatcher that always posts to the main looper.
    private val composition = CoroutineScope(looper.posting)

    @Before
    fun installMainLooper() {
        Dispatchers.setMain(looper.posting)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        composition.launch { owner.lifecycle.collectWhileStarted(effects.receiveAsFlow()) { delivered += it } }
        // The collector now waits for an effect.
        looper.runUntilIdle()
    }

    @After
    fun removeMainLooper() {
        composition.cancel()
        looper.runUntilIdle()
        Dispatchers.resetMain()
    }

    @Test
    fun `an effect emitted on the main thread while a stop is already queued is delivered once`() {
        // One main-thread turn: ON_STOP is already queued on the looper when an action emits an effect.
        looper.post { owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP) }
        effects.trySend("open-detail")
        looper.runUntilIdle()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        looper.runUntilIdle()

        assertEquals(listOf("open-detail"), delivered)
    }

    @Test
    fun `effects emitted while stopped wait for the next start and arrive once in order`() {
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        looper.runUntilIdle()
        effects.trySend("first")
        effects.trySend("second")
        looper.runUntilIdle()
        assertEquals(emptyList<String>(), delivered)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        looper.runUntilIdle()
        assertEquals(listOf("first", "second"), delivered)
    }

    @Test
    fun `an effect emitted while started is delivered within the emitting call`() {
        effects.trySend("open-detail")
        assertEquals(listOf("open-detail"), delivered)
    }
}

private class TestLifecycleOwner : LifecycleOwner {
    // Unsafe only in that it skips the main-thread check; the test thread plays the main thread.
    val registry = LifecycleRegistry.createUnsafe(this)
    override val lifecycle: Lifecycle get() = registry
}

/**
 * The main looper of a test, run on the test thread: posted tasks run one at a time, in order, when the test calls
 * [runUntilIdle]. [posting] posts every resumption, as Compose's dispatcher does; its `immediate` resumes in place,
 * as `Dispatchers.Main.immediate` does on the main thread.
 */
private class MainLooper {
    private val tasks = ArrayDeque<Runnable>()

    val posting: MainCoroutineDispatcher = Posting()

    fun post(task: Runnable) = tasks.addLast(task)

    fun runUntilIdle() {
        while (tasks.isNotEmpty()) tasks.removeFirst().run()
    }

    private inner class Posting : MainCoroutineDispatcher() {
        override val immediate: MainCoroutineDispatcher = InPlace()

        override fun dispatch(context: CoroutineContext, block: Runnable) = post(block)
    }

    private inner class InPlace : MainCoroutineDispatcher() {
        override val immediate: MainCoroutineDispatcher get() = this

        override fun isDispatchNeeded(context: CoroutineContext): Boolean = false

        override fun dispatch(context: CoroutineContext, block: Runnable) = post(block)
    }
}
