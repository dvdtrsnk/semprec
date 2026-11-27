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
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TestTimeSource

private val QUEUE_SESSION = StoredSession("https://s.example", "tok")
private val UNANSWERED = ApiResponse.Failure(FailureKind.UNAVAILABLE, null)
private const val QUEUED_AT = "2026-11-23T10:00:00Z"

private fun success(body: String = "{}", status: Int = 200) = ApiResponse.Success(status, body)

private fun failure(status: Int, kind: FailureKind) = ApiResponse.Failure(kind, status)

/** Refuses a `DELETE` as invalid and accepts every other write. */
private fun refusingDeletes(request: ApiRequest): ApiResponse =
    if (request.method == HttpMethod.Delete) failure(400, FailureKind.REJECTED) else success()

/**
 * Sends queued writes as the window's sender would, answering each with [answer], and records what it sent. Like the
 * window, it forgets the session when an answer is `401`.
 */
private class FakeSender(private var account: String?) : QueueSender {
    val sent = mutableListOf<ApiRequest>()
    var answer: suspend (ApiRequest) -> ApiResponse = { success() }

    override fun account(): String? = account

    override fun session(): StoredSession? = account?.let { QUEUE_SESSION }

    override suspend fun send(request: ApiRequest): ApiResponse {
        sent += request
        return answer(request).also { if (it is ApiResponse.Failure && it.status == 401) account = null }
    }

    override suspend fun upload(path: String, body: RawBody): ApiResponse = error("No queued write uploads")
}

@OptIn(ExperimentalCoroutinesApi::class)
class QueueReplayTest {
    private val directory = newTestDirectory()
    private val account = accountKey(QUEUE_SESSION)
    private var lastId = 0

    private fun TestScope.layer() = OfflineLayer(
        OfflineStore(directory, StandardTestDispatcher(testScheduler)),
        backgroundScope,
        TestTimeSource(),
        QueueClock(now = { QUEUED_AT }, random = { 0.0 }, today = { "2026-11-23" }),
        newId = { "n${++lastId}" },
    )

    private val patch =
        ApiRequest(HttpMethod.Patch, "/api/items/i1", body = """{"properties":{"name":"A"},"ifVersion":"v1"}""")
    private val create =
        ApiRequest(HttpMethod.Post, "/api/databases/d1/items", body = """{"properties":{"name":"T"}}""")

    private suspend fun OfflineLayer.write(
        request: ApiRequest,
        transmit: suspend (ApiRequest) -> ApiResponse = { UNANSWERED },
    ): ApiResponse = write(QUEUE_SESSION, checkNotNull(QueuedRoute.of(request.method, request.path)), request, transmit)

    private suspend fun OfflineLayer.queued(): QueueState = checkNotNull(store.queue.state(account))

    /** Makes [layer] offline, as a request without an answer does. */
    private suspend fun offline(layer: OfflineLayer) = layer.observed(UNANSWERED)

    @Test fun `a write sent directly returns the server's answer and queues nothing`() = runTest {
        val layer = layer()
        val answer = success("""{"id":"i1","databaseId":"d1","version":"v2"}""")
        assertEquals(answer, layer.write(patch) { answer })
        assertTrue(layer.queued().writes.isEmpty())
    }

    @Test fun `a refused direct write is returned as it came and queues nothing`() = runTest {
        val layer = layer()
        val refused = failure(400, FailureKind.REJECTED)
        assertEquals(refused, layer.write(patch) { refused })
        assertTrue(layer.queued().writes.isEmpty())
    }

    @Test fun `a direct write without an answer waits in the queue and answers the made-up answer`() = runTest {
        val layer = layer()
        val answer = assertIs<ApiResponse.Success>(layer.write(patch))
        assertEquals("i1", Json.parseToJsonElement(answer.body).jsonObject.getValue("id").jsonPrimitive.content)
        assertEquals(listOf("/api/items/i1"), layer.queued().writes.map { it.path })
        assertEquals(1, layer.writes.status.value.waiting)
    }

    @Test fun `a direct write answered with a server error or a throttle waits in the queue`() = runTest {
        val layer = layer()
        layer.write(patch) { failure(503, FailureKind.UNAVAILABLE) }
        layer.write(patch) { failure(429, FailureKind.UNAVAILABLE) }
        assertEquals(2, layer.queued().writes.size)
    }

    @Test fun `offline a write is queued at once without going out`() = runTest {
        val layer = layer()
        offline(layer)
        var transmitted = 0
        layer.write(patch) {
            transmitted += 1
            success()
        }
        assertEquals(0, transmitted)
        assertEquals(1, layer.queued().writes.size)
    }

    @Test fun `behind a waiting write the caller gets its own answer from the server`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(create)
        val gate = CompletableDeferred<Unit>()
        val sender = FakeSender(account).apply {
            answer = { request ->
                if (request.path.endsWith("/items")) gate.await()
                when (request.method) {
                    HttpMethod.Post -> success("""{"id":"s1"}""", 201)
                    else -> success("""{"server":true}""")
                }
            }
        }
        layer.writes.attach(sender)
        layer.observed(success())
        runCurrent()
        val second = async { layer.write(patch) }
        runCurrent()
        gate.complete(Unit)
        assertEquals(success("""{"server":true}"""), second.await())
        assertEquals(listOf("/api/databases/d1/items", "/api/items/i1"), sender.sent.map { it.path })
    }

    @Test fun `a caller waiting behind others gets the made-up answer after ten seconds`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(create)
        val sender = FakeSender(account).apply { answer = { CompletableDeferred<ApiResponse>().await() } }
        layer.writes.attach(sender)
        layer.observed(success())
        runCurrent()
        val second = async { layer.write(patch) }
        advanceTimeBy(QUEUED_WRITE_WAIT - 1.milliseconds)
        assertTrue(second.isActive)
        advanceTimeBy(2.milliseconds)
        val answer = assertIs<ApiResponse.Success>(second.await())
        assertEquals(200, answer.status)
        assertEquals(2, layer.queued().writes.size)
    }

    @Test fun `a caller waiting behind others gets the made-up answer at once when the replay stops`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(create)
        val gate = CompletableDeferred<Unit>()
        val sender = FakeSender(account).apply {
            answer = {
                gate.await()
                UNANSWERED
            }
        }
        layer.writes.attach(sender)
        layer.observed(success())
        runCurrent()
        val second = async { layer.write(patch) }
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertTrue(second.isCompleted)
        assertIs<ApiResponse.Success>(second.await())
    }

    @Test fun `the queue is found again by a new layer and replayed when a sender attaches`() = runTest {
        val first = layer()
        offline(first)
        first.write(patch)
        val second = layer()
        val sender = FakeSender(account)
        second.writes.attach(sender)
        runCurrent()
        assertEquals(listOf("/api/items/i1"), sender.sent.map { it.path })
        assertTrue(second.queued().writes.isEmpty())
    }

    @Test fun `the server id of a create replaces the made id in the writes that name it`() = runTest {
        val layer = layer()
        offline(layer)
        val created = assertIs<ApiResponse.Success>(layer.write(create))
        val made = Json.parseToJsonElement(created.body).jsonObject.getValue("id").jsonPrimitive.content
        layer.write(ApiRequest(HttpMethod.Patch, "/api/items/$made", body = """{"properties":{"name":"B"}}"""))
        layer.write(ApiRequest(HttpMethod.Put, "/api/items/p1/relations/tasks/$made"))
        layer.write(ApiRequest(HttpMethod.Patch, "/api/items/p1", body = """{"properties":{"ref":"$made"}}"""))
        val sender = FakeSender(account).apply {
            answer = { request ->
                if (request.path == "/api/databases/d1/items") success("""{"id":"s1"}""", 201) else success()
            }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(
            listOf("/api/databases/d1/items", "/api/items/s1", "/api/items/p1/relations/tasks/s1", "/api/items/p1"),
            sender.sent.map { it.path },
        )
        assertEquals("""{"properties":{"ref":"s1"}}""", sender.sent.last().body)
        assertEquals(mapOf(made to "s1"), layer.queued().ids)
    }

    @Test fun `a refused create drops the writes that name what it would have created`() = runTest {
        val layer = layer()
        offline(layer)
        val made = Json.parseToJsonElement(assertIs<ApiResponse.Success>(layer.write(create)).body)
            .jsonObject.getValue("id").jsonPrimitive.content
        layer.write(ApiRequest(HttpMethod.Patch, "/api/items/$made", body = """{"properties":{}}"""))
        layer.write(patch)
        val sender = FakeSender(account).apply {
            answer = { request ->
                if (request.path.startsWith("/api/databases")) failure(422, FailureKind.REJECTED) else success()
            }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(listOf("/api/databases/d1/items", "/api/items/i1"), sender.sent.map { it.path })
        val failures = layer.queued().failures
        assertEquals(listOf("POST /api/databases/:id/items", "PATCH /api/items/:id"), failures.map { it.route })
        assertEquals(listOf(FailureKind.REJECTED, FailureKind.REJECTED), failures.map { it.kind })
        assertEquals(QUEUED_AT, failures.first().at)
    }

    @Test fun `a write without an answer stays and is sent again after the backoff`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply { answer = { UNANSWERED } }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(1, sender.sent.size)
        advanceTimeBy(999.milliseconds)
        assertEquals(1, sender.sent.size)
        advanceTimeBy(2.milliseconds)
        assertEquals(2, sender.sent.size)
        assertEquals(1, layer.queued().writes.size)
        assertEquals(0, layer.queued().writes.single().attempts)
    }

    @Test fun `a write answered with server errors is dropped after eight attempts`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply { answer = { failure(503, FailureKind.UNAVAILABLE) } }
        layer.writes.attach(sender)
        advanceTimeBy(10.seconds * MAX_QUEUED_WRITE_ATTEMPTS * 10)
        assertEquals(MAX_QUEUED_WRITE_ATTEMPTS, sender.sent.size)
        assertTrue(layer.queued().writes.isEmpty())
        assertEquals(FailureKind.UNAVAILABLE, layer.queued().failures.single().kind)
    }

    @Test fun `a refused session stops the replay and keeps the write`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply { answer = { failure(401, FailureKind.UNAUTHORIZED) } }
        layer.writes.attach(sender)
        advanceTimeBy(5.seconds * 60)
        assertEquals(1, sender.sent.size)
        assertEquals(1, layer.queued().writes.size)
    }

    @Test fun `deleting an item that is gone already counts as done`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(ApiRequest(HttpMethod.Delete, "/api/items/i1"))
        val sender = FakeSender(account).apply { answer = { failure(404, FailureKind.NOT_FOUND) } }
        layer.writes.attach(sender)
        runCurrent()
        assertTrue(layer.queued().writes.isEmpty())
        assertTrue(layer.queued().failures.isEmpty())
    }

    @Test fun `changing an item that is gone is dropped as not found`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply { answer = { failure(404, FailureKind.NOT_FOUND) } }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(FailureKind.NOT_FOUND, layer.queued().failures.single().kind)
    }

    @Test fun `a stale version is read again and the change sent once more against it`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        var patches = 0
        val sender = FakeSender(account).apply {
            answer = { request ->
                when (request.method) {
                    HttpMethod.Get -> success("""{"id":"i1","version":"v9"}""")
                    else -> if (++patches == 1) failure(409, FailureKind.REJECTED) else success()
                }
            }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(listOf(HttpMethod.Patch, HttpMethod.Get, HttpMethod.Patch), sender.sent.map { it.method })
        val resent = Json.parseToJsonElement(checkNotNull(sender.sent.last().body)).jsonObject
        assertEquals("v9", resent.getValue("ifVersion").jsonPrimitive.content)
        assertEquals("A", resent.getValue("properties").jsonObject.getValue("name").jsonPrimitive.content)
        assertTrue(layer.queued().writes.isEmpty())
        assertTrue(layer.queued().failures.isEmpty())
    }

    @Test fun `a version stale twice is dropped`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply {
            answer = { request ->
                when (request.method) {
                    HttpMethod.Get -> success("""{"version":"v9"}""")
                    else -> failure(409, FailureKind.REJECTED)
                }
            }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(3, sender.sent.size)
        assertEquals(FailureKind.REJECTED, layer.queued().failures.single().kind)
    }

    @Test fun `a conflict of a change without a version is dropped without reading the item`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(ApiRequest(HttpMethod.Patch, "/api/items/i1", body = """{"properties":{}}"""))
        val sender = FakeSender(account).apply { answer = { failure(409, FailureKind.REJECTED) } }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(1, sender.sent.size)
        assertEquals(1, layer.queued().failures.size)
    }

    @Test fun `a stale version whose item cannot be read is dropped`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(account).apply {
            answer = { request ->
                when (request.method) {
                    HttpMethod.Get -> failure(404, FailureKind.NOT_FOUND)
                    else -> failure(409, FailureKind.REJECTED)
                }
            }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(FailureKind.REJECTED, layer.queued().failures.single().kind)
    }

    @Test fun `a create gets an idempotency key that its replay keeps`() = runTest {
        val layer = layer()
        var direct: ApiRequest? = null
        layer.write(create) {
            direct = it
            UNANSWERED
        }
        val key = checkNotNull(direct).extraHeaders.single { it.first == "Idempotency-Key" }.second
        val sender = FakeSender(account).apply { answer = { success("""{"id":"s1"}""", 201) } }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(key, sender.sent.single().extraHeaders.single { it.first == "Idempotency-Key" }.second)
    }

    @Test fun `a create that carries its own idempotency key keeps it`() = runTest {
        val layer = layer()
        var direct: ApiRequest? = null
        layer.write(create.copy(extraHeaders = listOf("Idempotency-Key" to "own"))) {
            direct = it
            success("""{"id":"s1"}""", 201)
        }
        assertEquals(listOf("Idempotency-Key" to "own"), checkNotNull(direct).extraHeaders)
    }

    @Test fun `a write that creates nothing gets no idempotency key`() = runTest {
        var direct: ApiRequest? = null
        layer().write(patch) {
            direct = it
            success()
        }
        assertTrue(checkNotNull(direct).extraHeaders.isEmpty())
    }

    @Test fun `a create answered without an id drops what names it`() = runTest {
        val layer = layer()
        offline(layer)
        val made = Json.parseToJsonElement(assertIs<ApiResponse.Success>(layer.write(create)).body)
            .jsonObject.getValue("id").jsonPrimitive.content
        layer.write(ApiRequest(HttpMethod.Delete, "/api/items/$made"))
        val sender = FakeSender(account).apply { answer = { success("{}", 201) } }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(1, sender.sent.size)
        assertEquals(FailureKind.INVALID_DATA, layer.queued().failures.single().kind)
    }

    @Test fun `every outcome of the replay tells the windows`() = runTest {
        val layer = layer()
        var told = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler), start = CoroutineStart.UNDISPATCHED) {
            layer.changes.collect { told += 1 }
        }
        offline(layer)
        layer.write(patch)
        layer.write(ApiRequest(HttpMethod.Delete, "/api/items/i2"))
        layer.observed(success())
        told = 0
        val sender = FakeSender(account).apply {
            answer = { request -> refusingDeletes(request) }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(2, told)
    }

    @Test fun `the status counts the waiting writes and the failures until they are forgotten`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        layer.write(ApiRequest(HttpMethod.Delete, "/api/items/i2"))
        assertEquals(2, layer.writes.status.value.waiting)
        val sender = FakeSender(account).apply {
            answer = { request -> refusingDeletes(request) }
        }
        layer.writes.attach(sender)
        runCurrent()
        assertEquals(0, layer.writes.status.value.waiting)
        assertEquals(1, layer.writes.status.value.failures.size)
        layer.writes.forgetFailures()
        assertTrue(layer.writes.status.value.failures.isEmpty())
        assertTrue(layer.queued().failures.isEmpty())
    }

    @Test fun `nobody signed in replays nothing`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        val sender = FakeSender(null)
        layer.writes.attach(sender)
        runCurrent()
        assertTrue(sender.sent.isEmpty())
    }

    @Test fun `the end of the session removes the queue and later writes go out as before`() = runTest {
        val layer = layer()
        offline(layer)
        layer.write(patch)
        layer.clear()
        var transmitted = 0
        val answer = layer.write(patch) {
            transmitted += 1
            UNANSWERED
        }
        assertEquals(UNANSWERED, answer)
        assertEquals(1, transmitted)
        assertNull(layer.store.queue.state(account))
    }

    @Test fun `the replay delay doubles from a second up to a minute`() {
        assertEquals(1_000L, nextReplayDelayMillis(0) { 1.0 })
        assertEquals(2_000L, nextReplayDelayMillis(1) { 1.0 })
        assertEquals(32_000L, nextReplayDelayMillis(5) { 1.0 })
        assertEquals(60_000L, nextReplayDelayMillis(6) { 1.0 })
        assertEquals(60_000L, nextReplayDelayMillis(30) { 1.0 })
        assertEquals(1_000L, nextReplayDelayMillis(30) { 0.0 })
    }
}
