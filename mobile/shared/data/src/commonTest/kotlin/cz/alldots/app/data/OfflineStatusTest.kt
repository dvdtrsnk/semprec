package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.OfflineStatus
import io.ktor.http.HttpMethod
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.TestTimeSource

private val STATUS_SESSION = StoredSession("https://s.example", "tok")
private val STATUS_NO_ANSWER = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)

/** Answers every replayed write with [answer]. */
private class StatusSender : QueueSender {
    var answer: ApiResponse = STATUS_NO_ANSWER

    override fun account(): String = accountKey(STATUS_SESSION)

    override suspend fun send(request: ApiRequest): ApiResponse = answer
}

/** The status the offline layer tells: its offline state and what the queue of the signed-in account holds. */
@OptIn(ExperimentalCoroutinesApi::class)
class OfflineStatusTest {
    private val directory = newTestDirectory()
    private val sender = StatusSender()

    private fun TestScope.layer() = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        TestTimeSource(),
        QueueClock(now = { "2026-11-23T10:00:00Z" }, random = { 0.0 }, today = { "2026-11-23" }),
    ).also { it.writes.attach(sender) }

    private suspend fun OfflineLayer.queued() =
        write(STATUS_SESSION, QueuedRoute.DELETE_ITEM, ApiRequest(HttpMethod.Delete, "/api/items/t1")) {
            STATUS_NO_ANSWER
        }

    @Test fun `the status is offline while requests get no answer and online once one is answered`() = runTest {
        val layer = layer()
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 0), layer.status.first())
        layer.observed(STATUS_NO_ANSWER)
        assertEquals(OfflineStatus(offline = true, waiting = 0, failed = 0), layer.status.first())
        layer.observed(ApiResponse.Success(200, "{}"))
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 0), layer.status.first())
    }

    @Test fun `the status counts the changes that wait and those refused until they are forgotten`() = runTest {
        val layer = layer()
        layer.queued()
        runCurrent()
        assertEquals(OfflineStatus(offline = true, waiting = 1, failed = 0), layer.status.first())

        sender.answer = ApiResponse.Failure(FailureKind.REJECTED, 400)
        layer.connected()
        runCurrent()
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 1), layer.status.first())

        layer.forgetFailures()
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 0), layer.status.first())
    }

    @Test fun `a change sent once the connection is back leaves nothing waiting`() = runTest {
        val layer = layer()
        layer.queued()
        sender.answer = ApiResponse.Success(204, "")
        layer.connected()
        runCurrent()
        assertEquals(OfflineStatus(offline = false, waiting = 0, failed = 0), layer.status.first())
    }

    @Test fun `ending the session leaves nothing waiting and nothing refused`() = runTest {
        val layer = layer()
        layer.queued()
        runCurrent()
        layer.clear()
        assertEquals(OfflineStatus(offline = true, waiting = 0, failed = 0), layer.status.first())
    }
}
