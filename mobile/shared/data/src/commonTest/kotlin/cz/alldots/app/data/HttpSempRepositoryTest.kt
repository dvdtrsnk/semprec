package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempChangeKind
import cz.alldots.app.domain.SempMessageStatus
import cz.alldots.app.domain.SempRefInput
import cz.alldots.app.domain.SempRefKind
import cz.alldots.app.domain.SempRole
import cz.alldots.app.domain.SempSendRequest
import cz.alldots.app.domain.SempStepStatus
import cz.alldots.app.domain.SempThreadKind
import cz.alldots.app.domain.SempThreadsQuery
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SERVER = "https://s.example"

private const val THREAD_LIST =
    """{"rows":[""" +
        """{"id":"t1","kind":"chat","title":"Plan","preview":"Done.","lastActivityAt":"2026-10-21T13:21:00.000Z",""" +
        """"hasPendingApproval":true,"heartbeat":null,"subject":null},""" +
        """{"id":"t2","kind":"tick","title":"Weekly","preview":{"key":"approval.outcome.executed","params":{}},""" +
        """"lastActivityAt":"2026-10-20T21:00:00.000Z","hasPendingApproval":false,""" +
        """"heartbeat":{"id":"h","name":"Weekly","projectItemId":"p","projectName":"Diary"},"subject":null},""" +
        """{"id":"t3","kind":"item","title":null,"preview":null,"lastActivityAt":"2026-10-19T08:00:00.000Z",""" +
        """"hasPendingApproval":false,"heartbeat":null,"subject":{"inboxItemId":"i1","exists":true}},""" +
        """{"id":"t4","kind":"future","title":null,"preview":null,"lastActivityAt":"2026-10-18T08:00:00.000Z"}""" +
        """],"nextCursor":"next"}"""

private const val MESSAGES =
    """{"rows":[""" +
        """{"id":"a1","role":"assistant","text":"Hotovo.","system":null,"context":null,"replyToMessageId":"u1",""" +
        """"attempt":2,"replaced":false,"agentRunId":"r1","status":"done",""" +
        """"createdAt":"2026-10-21T13:24:06.000000Z",""" +
        """"steps":[{"kind":"tool","status":"ok","durationMs":400,"label":{"key":"k","params":{}},""" +
        """"detail":{"key":"d","params":{}}},{"kind":"tool","status":"wait","durationMs":0,""" +
        """"approvalRequestId":"ap1","approval":{"status":"pending","executionStatus":"not_approved",""" +
        """"conflictReason":null}},{"kind":"model","status":"surprise","durationMs":1}],""" +
        """"changes":[{"itemId":"i","databaseId":"d","change":"updated","changedKeys":["date"],""" +
        """"resolved":{"label":"Send invoice","databaseKey":"tasks","state":"active"}}],""" +
        """"outcome":"incomplete","incompleteReason":"toolTimeout","run":null},""" +
        """{"id":"u1","role":"user","text":"Move it","system":null,"context":[{"kind":"item","itemId":"i",""" +
        """"databaseId":"d","resolved":{"label":"Send invoice","databaseKey":"tasks","state":"active"}},""" +
        """{"kind":"mailThread","threadId":"m1","resolved":{"label":null,"databaseKey":null,"state":"purged"}},""" +
        """{"kind":"sleepNight","night":"2026-10-20"}],"replyToMessageId":null,"agentRunId":null,"status":null,""" +
        """"createdAt":"2026-10-21T13:24:00.000000Z","outcome":"complete","run":null},""" +
        """{"id":"s1","role":"system","text":null,"system":{"key":"approval.outcome.rejected","params":null},""" +
        """"context":[],"replyToMessageId":null,"agentRunId":null,"status":null,""" +
        """"createdAt":"2026-10-21T13:25:00.000000Z","outcome":"complete","run":null},""" +
        """{"id":"e1","role":"assistant","text":null,"context":null,"replyToMessageId":"u2","agentRunId":null,""" +
        """"status":"error","createdAt":"2026-10-21T13:26:00.000000Z","outcome":"complete","run":null,""" +
        """"error":{"code":"modelError","message":"The model failed."}},""" +
        """{"id":"x","role":"robot","text":null,"createdAt":"2026-10-21T13:27:00.000000Z"}""" +
        """],"nextCursor":null}"""

class HttpSempRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpSempRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession(SERVER, "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpSempRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun `the history asks for the kinds the search and the page and maps every row it can read`() = runTest {
        val repository = repository { json(THREAD_LIST) }

        val query = SempThreadsQuery(
            setOf(SempThreadKind.CHAT, SempThreadKind.TICK),
            search = "faktura",
            cursor = "c1",
            subjectInboxItemId = "i1",
        )
        val page = (repository.threads(query) as RepositoryResult.Content).value
        val request = requests.single()

        assertEquals("chat,tick", request.url.parameters["kind"])
        assertEquals("faktura", request.url.parameters["q"])
        assertEquals("c1", request.url.parameters["cursor"])
        assertEquals("i1", request.url.parameters["subjectInboxItemId"])
        assertEquals("50", request.url.parameters["limit"])
        val rows = page.rows
        assertEquals(listOf("t1", "t2", "t3"), rows.map { it.id })
        assertEquals("next", page.nextCursor)
        assertEquals("Done.", rows[0].preview?.text)
        assertTrue(rows[0].hasPendingApproval)
        assertEquals("approval.outcome.executed", rows[1].preview?.systemKey)
        assertEquals("Diary", rows[1].projectName)
        assertEquals(SempThreadKind.ITEM, rows[2].kind)
        assertEquals("i1", rows[2].subjectInboxItemId)
        assertNull(rows[2].preview)
    }

    @Test
    fun `a tick thread keeps its automation and its running run`() = runTest {
        val repository = repository {
            json(
                """{"id":"t2","kind":"tick","title":"Weekly","createdAt":"x","lastActivityAt":"y","heartbeat":""" +
                    """{"id":"h","name":"Weekly","rule":{"kind":"cron"},"enabled":true,"projectItemId":"p",""" +
                    """"projectName":null,"canTrigger":true},"activeRun":{"agentRunId":"r9","startedAt":"z"}}""",
            )
        }

        val thread = (repository.thread("t2") as RepositoryResult.Content).value

        assertEquals("/api/semp/threads/t2", requests.single().url.encodedPath)
        assertEquals(SempThreadKind.TICK, thread.kind)
        assertEquals("h", thread.tick?.heartbeatId)
        assertTrue(thread.tick?.canTrigger == true)
        assertNull(thread.tick?.projectName)
        assertEquals("r9", thread.activeRunId)
    }

    @Test
    fun `a thread of an unknown kind is invalid data`() = runTest {
        val repository = repository { json("""{"id":"t","kind":"voice","createdAt":"x","lastActivityAt":"y"}""") }

        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), repository.thread("t"))
    }

    @Test
    fun `messages map the reply the steps the changes the context and the failure`() = runTest {
        val repository = repository { json(MESSAGES) }

        val page = (repository.messages("t1", "before-1") as RepositoryResult.Content).value
        val request = requests.single()

        assertEquals("/api/semp/threads/t1/messages", request.url.encodedPath)
        assertEquals("before-1", request.url.parameters["before"])
        assertEquals(listOf("a1", "u1", "s1", "e1"), page.rows.map { it.id })
        val reply = page.rows[0]
        assertEquals(SempRole.ASSISTANT, reply.role)
        assertEquals(2, reply.attempt)
        assertEquals("u1", reply.replyToMessageId)
        assertEquals("r1", reply.agentRunId)
        assertTrue(reply.incomplete)
        assertEquals(listOf(SempStepStatus.OK, SempStepStatus.WAIT), reply.steps.map { it.status })
        assertEquals("pending", reply.steps[1].approval?.status)
        assertEquals("ap1", reply.steps[1].approvalRequestId)
        assertEquals(SempChangeKind.UPDATED, reply.changes.single().kind)
        assertEquals("Send invoice", reply.changes.single().label)
        assertTrue(reply.changes.single().active)
        val user = page.rows[1]
        assertEquals(SempMessageStatus.DONE, user.status)
        assertEquals(listOf(SempRefKind.ITEM, SempRefKind.MAIL_THREAD, SempRefKind.OTHER), user.context.map { it.kind })
        assertEquals("Send invoice", user.context[0].label)
        assertEquals("tasks", user.context[0].databaseKey)
        assertEquals("d", user.context[0].databaseId)
        assertTrue(!user.context[1].exists)
        assertEquals("approval.outcome.rejected", page.rows[2].systemKey)
        val failed = page.rows[3]
        assertEquals(SempMessageStatus.ERROR, failed.status)
        assertEquals("modelError", failed.error?.code)
        assertEquals("The model failed.", failed.error?.message)
    }

    @Test
    fun `a message to a new chat carries only the references the server takes`() = runTest {
        val repository = repository { json("""{"threadId":"t9","messageId":"m1","assistantMessageId":"m2"}""") }

        val receipt = repository.send(
            SempSendRequest(
                threadId = null,
                subjectInboxItemId = null,
                text = "Move it",
                context = listOf(
                    SempRefInput(SempRefKind.ITEM, "i1", "d1"),
                    SempRefInput(SempRefKind.ITEM, "i2", null),
                    SempRefInput(SempRefKind.AGENT_RUN, "r1", null),
                    SempRefInput(SempRefKind.OTHER, "x", null),
                ),
            ),
        )

        assertEquals("t9", (receipt as RepositoryResult.Content).value.threadId)
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/semp/threads", request.url.encodedPath)
        val body = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("Move it", body.getValue("text").jsonPrimitive.content)
        val context = body.getValue("context").toString()
        assertEquals(
            """[{"kind":"item","itemId":"i1","databaseId":"d1"},{"kind":"agentRun","agentRunId":"r1"}]""",
            context,
        )
        assertTrue("subject" !in body)
    }

    @Test
    fun `a message about an inbox item names its subject and sends no context`() = runTest {
        val repository = repository { json("""{"threadId":"t9","messageId":"m1","assistantMessageId":"m2"}""") }

        repository.send(SempSendRequest(null, "inbox-1", "Change it", emptyList()))

        val body = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("inbox-1", body.getValue("subject").jsonObject.getValue("inboxItemId").jsonPrimitive.content)
        assertTrue("context" !in body)
    }

    @Test
    fun `a message to a thread goes to its messages and the retry and the regeneration to theirs`() = runTest {
        val repository = repository { json("""{"threadId":"t1","messageId":"m1","assistantMessageId":"m2"}""") }

        repository.send(SempSendRequest("t1", null, "Hi", emptyList()))
        repository.retry("t1", "a1")
        repository.regenerate("t1", "a2")

        assertEquals(
            listOf(
                "/api/semp/threads/t1/messages",
                "/api/semp/threads/t1/messages/a1/retry",
                "/api/semp/threads/t1/messages/a2/regenerate",
            ),
            requests.map { it.url.encodedPath },
        )
        assertEquals(listOf(HttpMethod.Post, HttpMethod.Post, HttpMethod.Post), requests.map { it.method })
    }

    @Test
    fun `answers that are not usable become the failure they stand for`() = runTest {
        val missing = repository { json("{}", HttpStatusCode.NotFound) }
        val busy = repository { json("{}", HttpStatusCode.ServiceUnavailable) }
        val garbled = repository { json("""{"rows":"no"}""") }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), missing.messages("t1", null))
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), busy.retry("t1", "a1"))
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), garbled.threads(SempThreadsQuery(emptySet())))
    }
}
