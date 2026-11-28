package cz.alldots.app.domain

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class SyncChangesTest {
    @Test fun `a raise reaches the collectors of its topics only and nothing raised before they started`() = runTest {
        val changes = SyncChanges()
        changes.raise(setOf(SyncTopic.CALENDAR))
        val received = SyncTopic.entries.associateWith { 0 }.toMutableMap()
        SyncTopic.entries.forEach { topic ->
            backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
                changes.changes(topic).collect { received[topic] = received.getValue(topic) + 1 }
            }
        }
        runCurrent()
        assertEquals(SyncTopic.entries.associateWith { 0 }, received)

        changes.raise(setOf(SyncTopic.CALENDAR, SyncTopic.INVITATIONS))
        changes.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        val raised = mapOf(
            SyncTopic.CALENDAR to 1,
            SyncTopic.INVITATIONS to 1,
            SyncTopic.MAIL_ACCOUNTS to 1,
            SyncTopic.MAIL_THREADS to 0,
        )
        assertEquals(raised, received)
        changes.raise(emptySet())
        runCurrent()
        assertEquals(raised, received)
    }

    @Test fun `raises faster than the collector reads arrive as one`() = runTest {
        val changes = SyncChanges()
        var received = 0
        backgroundScope.launch { changes.changes(SyncTopic.CALENDAR).collect { received += 1 } }
        runCurrent()
        repeat(5) { changes.raise(setOf(SyncTopic.CALENDAR)) }
        runCurrent()
        assertEquals(1, received)
    }
}
