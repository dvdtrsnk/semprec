package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import io.ktor.http.HttpMethod
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource

private val SESSION = StoredSession("https://s.example", "tok")
private val NO_ANSWER = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)

private fun answered(body: String) = ApiResponse.Success(200, body, "\"$body\"")

/** A server that answers each request with the next of [answers], the last one again once they run out. */
private class ScriptedServer(vararg answers: ApiResponse) {
    private val queue = ArrayDeque(answers.toList())
    var sent = 0
        private set

    fun next(vararg answers: ApiResponse) {
        queue.clear()
        queue.addAll(answers)
    }

    fun transmit(): ApiResponse {
        sent += 1
        return if (queue.size > 1) queue.removeFirst() else queue.first()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineLayerTest {
    private val directory = newTestDirectory()
    private val time = TestTimeSource()
    private val overview = ApiRequest(HttpMethod.Get, "/api/overview")
    private val timeline = ApiRequest(HttpMethod.Get, "/api/calendar/timeline", listOf("from" to "a", "to" to "b"))

    private fun TestScope.layer() =
        OfflineLayer(OfflineStore(directory, StandardTestDispatcher(testScheduler)), backgroundScope, time)

    private suspend fun OfflineLayer.read(server: ScriptedServer, request: ApiRequest = overview) =
        read(SESSION, request) { server.transmit() }

    /** Counts what [OfflineLayer.changes] emits while the test runs. */
    private fun TestScope.emissions(layer: OfflineLayer): () -> Int {
        var count = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler), start = CoroutineStart.UNDISPATCHED) {
            layer.changes.collect { count += 1 }
        }
        return { count }
    }

    /** Leaves the layer offline with "a" kept for [overview]. */
    private suspend fun TestScope.offlineWithKept(layer: OfflineLayer, server: ScriptedServer) {
        server.next(answered("a"))
        layer.read(server)
        layer.frameArrived()
        server.next(NO_ANSWER)
        layer.read(server)
        runCurrent()
    }

    @Test fun `a fresh kept answer is answered without a request`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        assertEquals(answered("a"), layer.read(server))
        assertEquals(answered("a"), layer.read(server))
        assertEquals(1, server.sent)
    }

    @Test fun `answers are kept per request key`() = runTest {
        val server = ScriptedServer(answered("a"), answered("b"))
        val layer = layer()
        assertEquals(answered("a"), layer.read(server, overview))
        assertEquals(answered("b"), layer.read(server, timeline))
        assertEquals(answered("a"), layer.read(server, overview))
        assertEquals(2, server.sent)
    }

    @Test fun `a write makes every kept answer stale`() = runTest {
        val server = ScriptedServer(answered("a"), answered("b"))
        val layer = layer()
        layer.read(server)
        layer.wrote()
        assertEquals(answered("b"), layer.read(server))
        assertEquals(2, server.sent)
    }

    @Test fun `a socket connect makes every kept answer stale`() = runTest {
        val server = ScriptedServer(answered("a"), answered("b"))
        val layer = layer()
        layer.read(server)
        layer.connected()
        assertEquals(answered("b"), layer.read(server))
    }

    @Test fun `a socket frame makes every kept answer stale`() = runTest {
        val server = ScriptedServer(answered("a"), answered("b"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        assertEquals(answered("b"), layer.read(server))
    }

    @Test fun `an answer stays fresh for five minutes and no longer`() = runTest {
        val server = ScriptedServer(answered("a"), answered("b"))
        val layer = layer()
        layer.read(server)
        time += KEPT_ANSWER_FRESH_FOR - 1.seconds
        assertEquals(answered("a"), layer.read(server))
        time += 1.seconds
        assertEquals(answered("b"), layer.read(server))
        assertEquals(2, server.sent)
    }

    @Test fun `a change signal while a request is out leaves its answer stale`() = runTest {
        val release = CompletableDeferred<Unit>()
        var sent = 0
        val layer = layer()
        val first = async {
            layer.read(SESSION, overview) {
                sent += 1
                release.await()
                answered("a")
            }
        }
        runCurrent()
        layer.frameArrived()
        release.complete(Unit)
        first.await()
        layer.read(SESSION, overview) {
            sent += 1
            answered("b")
        }
        assertEquals(2, sent)
    }

    @Test fun `a read without an answer returns the kept answer`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        server.next(NO_ANSWER)
        assertEquals(answered("a"), layer.read(server))
    }

    @Test fun `a read without an answer and nothing kept returns the failure`() = runTest {
        val server = ScriptedServer(NO_ANSWER)
        assertEquals(NO_ANSWER, layer().read(server))
    }

    @Test fun `a server error returns the kept answer`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        server.next(ApiResponse.Failure(FailureKind.UNAVAILABLE, 503))
        assertEquals(answered("a"), layer.read(server))
    }

    @Test fun `a throttled read returns the kept answer`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        server.next(ApiResponse.Failure(FailureKind.UNAVAILABLE, 429))
        assertEquals(answered("a"), layer.read(server))
    }

    @Test fun `a server error with nothing kept returns the failure`() = runTest {
        val failure = ApiResponse.Failure(FailureKind.UNAVAILABLE, 503)
        assertEquals(failure, layer().read(ScriptedServer(failure)))
    }

    @Test fun `not found removes the kept answer`() = runTest {
        val notFound = ApiResponse.Failure(FailureKind.NOT_FOUND, 404)
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        server.next(notFound)
        assertEquals(notFound, layer.read(server))
        server.next(NO_ANSWER)
        assertEquals(NO_ANSWER, layer.read(server))
    }

    @Test fun `another refusal is returned and the kept answer stays`() = runTest {
        val refused = ApiResponse.Failure(FailureKind.REJECTED, 400)
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        server.next(refused)
        assertEquals(refused, layer.read(server))
        server.next(NO_ANSWER)
        assertEquals(answered("a"), layer.read(server))
    }

    @Test fun `offline a kept read answers at once and checks the connection every fifteen seconds`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        offlineWithKept(layer, server)
        val before = server.sent
        assertEquals(answered("a"), layer.read(server))
        runCurrent()
        assertEquals(before + 1, server.sent)
        assertEquals(answered("a"), layer.read(server))
        runCurrent()
        assertEquals(before + 1, server.sent)
        time += OFFLINE_PROBE_EVERY
        assertEquals(answered("a"), layer.read(server))
        runCurrent()
        assertEquals(before + 2, server.sent)
    }

    @Test fun `an answered probe ends the offline state and tells every window`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        val emitted = emissions(layer)
        offlineWithKept(layer, server)
        time += OFFLINE_PROBE_EVERY
        server.next(answered("b"))
        assertEquals(answered("a"), layer.read(server))
        runCurrent()
        assertEquals(1, emitted())
        server.next(answered("c"))
        assertEquals(answered("c"), layer.read(server))
    }

    @Test fun `an unanswered probe keeps the offline state and tells nobody`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        val emitted = emissions(layer)
        offlineWithKept(layer, server)
        time += OFFLINE_PROBE_EVERY
        layer.read(server)
        runCurrent()
        assertEquals(0, emitted())
        val before = server.sent
        assertEquals(answered("a"), layer.read(server))
        assertEquals(before, server.sent)
    }

    @Test fun `offline a read with nothing kept still goes out`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        offlineWithKept(layer, server)
        val before = server.sent
        assertEquals(NO_ANSWER, layer.read(server, timeline))
        assertEquals(before + 1, server.sent)
    }

    @Test fun `a socket connect ends the offline state and tells every window`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        val emitted = emissions(layer)
        offlineWithKept(layer, server)
        layer.connected()
        assertEquals(1, emitted())
        server.next(answered("b"))
        assertEquals(answered("b"), layer.read(server))
    }

    @Test fun `a socket connect while online tells nobody`() = runTest {
        val layer = layer()
        val emitted = emissions(layer)
        layer.connected()
        assertEquals(0, emitted())
    }

    @Test fun `a request outside the offline set without an answer makes the process offline`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.frameArrived()
        layer.observed(NO_ANSWER)
        server.next(answered("z"))
        assertEquals(answered("a"), layer.read(server))
    }

    @Test fun `an answer to a request outside the offline set ends the offline state`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        val emitted = emissions(layer)
        offlineWithKept(layer, server)
        layer.observed(ApiResponse.Failure(FailureKind.REJECTED, 400))
        assertEquals(1, emitted())
    }

    @Test fun `a write ends the offline state without telling the windows`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        val emitted = emissions(layer)
        offlineWithKept(layer, server)
        layer.wrote()
        assertEquals(0, emitted())
        server.next(answered("b"))
        assertEquals(answered("b"), layer.read(server))
    }

    @Test fun `kept answers are found again after a restart but are not fresh`() = runTest {
        layer().read(ScriptedServer(answered("a")))
        val online = ScriptedServer(answered("b"))
        assertEquals(answered("b"), layer().read(online))
        assertEquals(1, online.sent)
        assertEquals(answered("b"), layer().read(ScriptedServer(NO_ANSWER)))
    }

    @Test fun `clear removes everything kept and an answer of the ended session is not kept`() = runTest {
        val server = ScriptedServer(answered("a"))
        val layer = layer()
        layer.read(server)
        layer.clear()
        assertEquals(answered("a"), layer.read(server))
        server.next(NO_ANSWER)
        assertEquals(NO_ANSWER, layer.read(server))
        assertEquals(3, server.sent)
    }
}
