package cz.semprec.app.navigation

import androidx.lifecycle.SavedStateHandle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SceneNavigationTest {
    @Test
    fun `router calls queue their commands in order`() = runTest {
        val scene = SceneNavigation(SavedStateHandle())
        val ran = runCommands(scene)
        scene.home.showDetail("item-1")
        scene.home.closeDetail()
        scene.settings.showAbout()
        assertEquals(
            listOf(NavigationCommand.Detail("item-1"), NavigationCommand.CloseDetail, NavigationCommand.About),
            ran.map { it.command },
        )
        assertEquals(listOf(1L, 2L, 3L), ran.map { it.sequence })
    }

    @Test
    fun `a command waits for a collector`() = runTest {
        val scene = SceneNavigation(SavedStateHandle())
        scene.settings.showAbout()
        assertEquals(listOf(NavigationCommand.About), runCommands(scene).map { it.command })
    }

    @Test
    fun `the next command is delivered only after the previous one is acknowledged`() = runTest {
        val scene = SceneNavigation(SavedStateHandle())
        val received = mutableListOf<QueuedNavigation>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { scene.commands.collect(received::add) }
        scene.home.showDetail("item-1")
        // Queueing another command neither delivers it early nor delivers the unacknowledged one again.
        scene.settings.showAbout()
        assertEquals(listOf(QueuedNavigation(1, NavigationCommand.Detail("item-1"))), received)

        scene.acknowledge(1)
        assertEquals(
            listOf(
                QueuedNavigation(1, NavigationCommand.Detail("item-1")),
                QueuedNavigation(2, NavigationCommand.About),
            ),
            received,
        )
    }

    @Test
    fun `a command whose collector stopped before it ran is delivered again`() = runTest {
        val scene = SceneNavigation(SavedStateHandle())
        scene.home.showDetail("item-1")
        // The scene took the command but stopped while it waited for its tab, so it never acknowledged it.
        val waiting = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            scene.commands.collect { awaitCancellation() }
        }
        waiting.cancel()

        assertEquals(listOf(QueuedNavigation(1, NavigationCommand.Detail("item-1"))), runCommands(scene))
    }

    @Test
    fun `an acknowledged command is never delivered again`() = runTest {
        val scene = SceneNavigation(SavedStateHandle())
        scene.home.showDetail("item-1")
        assertEquals(1, runCommands(scene).size)

        assertEquals(emptyList<QueuedNavigation>(), runCommands(scene))
    }

    @Test
    fun `a command that has not run survives reconstruction`() = runTest {
        val state = SavedStateHandle()
        SceneNavigation(state).home.showDetail("item-1")

        val reconstructed = runCommands(SceneNavigation(state))
        assertEquals(listOf(QueuedNavigation(1, NavigationCommand.Detail("item-1"))), reconstructed)
    }

    @Test
    fun `an acknowledged command is not delivered again after reconstruction`() = runTest {
        val state = SavedStateHandle()
        val scene = SceneNavigation(state)
        scene.home.showDetail("item-1")
        scene.settings.showAbout()
        val received = mutableListOf<QueuedNavigation>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { scene.commands.collect(received::add) }
        scene.acknowledge(received.single().sequence)

        val reconstructed = runCommands(SceneNavigation(state))
        assertEquals(listOf(QueuedNavigation(2, NavigationCommand.About)), reconstructed)
    }

    @Test
    fun `sequence numbers continue after reconstruction`() = runTest {
        val state = SavedStateHandle()
        val scene = SceneNavigation(state)
        scene.home.showDetail("item-1")
        scene.acknowledge(1)

        val reconstructed = SceneNavigation(state)
        val ran = runCommands(reconstructed)
        reconstructed.home.closeDetail()
        assertEquals(listOf(QueuedNavigation(2, NavigationCommand.CloseDetail)), ran)
    }

    @Test
    fun `an unreadable saved command is dropped from the queue`() = runTest {
        val state = SavedStateHandle()
        state[SceneNavigation.PENDING_KEY] = arrayListOf("1|unknown", "2|about")
        val scene = SceneNavigation(state)
        assertEquals(listOf("2|about"), state.get<Any>(SceneNavigation.PENDING_KEY))
        assertEquals(listOf(QueuedNavigation(2, NavigationCommand.About)), runCommands(scene))
    }

    @Test
    fun `a saved queue of another type is dropped`() = runTest {
        listOf<Any>("1|about", 1, arrayOf("1|about")).forEach { saved ->
            val state = SavedStateHandle()
            state[SceneNavigation.PENDING_KEY] = saved
            val scene = SceneNavigation(state)
            assertEquals(saved.toString(), emptyList<String>(), state.get<Any>(SceneNavigation.PENDING_KEY))

            val ran = runCommands(scene)
            scene.home.showDetail("item-1")
            assertEquals(saved.toString(), listOf(QueuedNavigation(1, NavigationCommand.Detail("item-1"))), ran)
        }
    }

    @Test
    fun `a saved queue entry that is no string is dropped`() = runTest {
        val state = SavedStateHandle()
        state[SceneNavigation.PENDING_KEY] = arrayListOf<Any>(1, "2|about")
        val scene = SceneNavigation(state)
        assertEquals(listOf("2|about"), state.get<Any>(SceneNavigation.PENDING_KEY))
        assertEquals(listOf(QueuedNavigation(2, NavigationCommand.About)), runCommands(scene))
    }

    @Test
    fun `a second saved entry with a sequence already queued is dropped`() = runTest {
        val state = SavedStateHandle()
        state[SceneNavigation.PENDING_KEY] = arrayListOf("1|about", "1|closeDetail", "2|about")
        val scene = SceneNavigation(state)
        assertEquals(listOf("1|about", "2|about"), state.get<Any>(SceneNavigation.PENDING_KEY))
        assertEquals(
            listOf(QueuedNavigation(1, NavigationCommand.About), QueuedNavigation(2, NavigationCommand.About)),
            runCommands(scene),
        )
    }

    @Test
    fun `a saved next sequence of another type is replaced by one above every queued command`() = runTest {
        val expected = listOf(
            QueuedNavigation(4, NavigationCommand.About),
            QueuedNavigation(5, NavigationCommand.CloseDetail),
        )
        listOf<Any>(7, "7", 7.0).forEach { saved ->
            val state = SavedStateHandle()
            state[SceneNavigation.PENDING_KEY] = arrayListOf("4|about")
            state[SceneNavigation.NEXT_SEQUENCE_KEY] = saved
            val scene = SceneNavigation(state)
            assertEquals(saved.toString(), 5L, state.get<Any>(SceneNavigation.NEXT_SEQUENCE_KEY))

            val ran = runCommands(scene)
            scene.home.closeDetail()
            assertEquals(saved.toString(), expected, ran)
        }
    }

    @Test
    fun `a saved next sequence below a queued command is raised above it`() = runTest {
        val state = SavedStateHandle()
        state[SceneNavigation.PENDING_KEY] = arrayListOf("4|about")
        state[SceneNavigation.NEXT_SEQUENCE_KEY] = 2L
        val scene = SceneNavigation(state)

        val ran = runCommands(scene)
        scene.home.closeDetail()
        assertEquals(
            listOf(QueuedNavigation(4, NavigationCommand.About), QueuedNavigation(5, NavigationCommand.CloseDetail)),
            ran,
        )
    }

    /**
     * Runs [scene]'s commands the way the app scene does, for the rest of the test: each delivered command is
     * recorded and then acknowledged.
     */
    private fun TestScope.runCommands(scene: SceneNavigation): List<QueuedNavigation> {
        val ran = mutableListOf<QueuedNavigation>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            scene.commands.collect { queued ->
                ran += queued
                scene.acknowledge(queued.sequence)
            }
        }
        return ran
    }
}
