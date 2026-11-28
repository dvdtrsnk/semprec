package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempRunStatus
import cz.alldots.app.domain.SempRunStepKind
import cz.alldots.app.domain.SempRunStepState
import cz.alldots.app.domain.SempRunTrigger
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val RUN =
    """{"id":"r1","projectItemId":"p","title":"Move the invoice","displayStatus":"waiting_approval",""" +
        """"projectName":"Semp","heartbeatName":null,"startedAt":"2026-10-21T13:24:02.000Z","durationMs":4100,""" +
        """"trigger":{"kind":"user","threadId":"th","mcpClientName":null},""" +
        """"approvals":{"count":2,"pending":1,"approved":1,"rejected":0,"requestIds":["a","b"]},""" +
        """"errorCode":null,"errorSummary":null,"retriedByRunId":"r2","usage":{"totalCostUsd":0.021,""" +
        """"estimated":true,"perModel":[{"provider":"anthropic","model":"m","displayName":"Claude Sonnet",""" +
        """"callCount":2,"inputTokens":6180,"outputTokens":240,"audioSeconds":null,"costUsd":0.021}]}}"""

private const val STEPS =
    """{"steps":[""" +
        """{"stepId":"1","kind":"start","state":"ok","at":"t1","durationMs":null,"toolCallId":null,""" +
        """"operation":null,""" +
        """"mcp":null,"approvalRequestId":null,"title":"Start","targetName":null,"change":null,"summary":null},""" +
        """{"stepId":"2","kind":"approval","state":"waitingApproval","at":"t2","durationMs":300,"title":"Delete",""" +
        """"targetName":"Tax return","summary":"waits","approvalRequestId":"ap1","approvalState":"pending"},""" +
        """{"stepId":"3","kind":"mystery","state":"ok","at":"t3","title":"?"}],""" +
        """"nextCursor":null,"truncatedHistory":true}"""

class HttpSempRunRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpSempRunRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val engine = MockEngine { request ->
            requests += request
            handler(request)
        }
        return HttpSempRunRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun `a run maps its status trigger approvals cost and the answer it was scoped to`() = runTest {
        val repository = repository { json(RUN) }

        val run = (repository.run("r1", "m1") as RepositoryResult.Content).value

        assertEquals("/api/agent-runs/r1", requests.single().url.encodedPath)
        assertEquals("m1", requests.single().url.parameters["messageId"])
        assertEquals(SempRunStatus.WAITING_APPROVAL, run.status)
        assertEquals(SempRunTrigger.USER, run.trigger)
        assertEquals("th", run.threadId)
        assertEquals(4100L, run.durationMs)
        assertEquals(2, run.approvalCount)
        assertEquals(1, run.pendingApprovalCount)
        assertEquals("r2", run.retriedByRunId)
        assertEquals(0.021, run.totalCostUsd)
        assertTrue(run.costIsEstimate)
        assertEquals("Claude Sonnet", run.usage.single().modelName)
        assertEquals(6180L, run.usage.single().inputTokens)
    }

    @Test
    fun `a run without a message is read whole and one of an unknown status is invalid`() = runTest {
        val whole = repository { json(RUN) }
        whole.run("r1", null)
        assertNull(requests.single().url.parameters["messageId"])

        val strange = repository { json(RUN.replace("waiting_approval", "levitating")) }
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), strange.run("r1", null))
    }

    @Test
    fun `steps map the kind and state of each and skip a step the app does not know`() = runTest {
        val repository = repository { json(STEPS) }

        val page = (repository.steps("r1", "m1", "7") as RepositoryResult.Content).value

        assertEquals("/api/agent-runs/r1/steps", requests.single().url.encodedPath)
        assertEquals("7", requests.single().url.parameters["after"])
        assertEquals(listOf("1", "2"), page.steps.map { it.id })
        assertEquals(SempRunStepKind.APPROVAL, page.steps[1].kind)
        assertEquals(SempRunStepState.WAITING_APPROVAL, page.steps[1].state)
        assertEquals("Tax return", page.steps[1].targetName)
        assertEquals("ap1", page.steps[1].approvalRequestId)
        assertTrue(page.truncatedHistory)
        assertNull(page.nextCursor)
    }

    @Test
    fun `the list of a project asks for that project and maps the rows`() = runTest {
        val repository = repository {
            json(
                """{"rows":[{"id":"r1:m1","agentRunId":"r1","messageId":"m1","title":"Morning",""" +
                    """"triggeredBy":"heartbeat",""" +
                    """"triggerLabel":"Tick","startedAt":"t","durationMs":12000,"costUsd":0.04,""" +
                    """"displayStatus":"done",""" +
                    """"errorSummary":null,"attempt":1},{"id":"r3","agentRunId":"r3","messageId":null,""" +
                    """"title":"Failing",""" +
                    """"triggeredBy":"user","startedAt":"t","durationMs":null,"costUsd":0,"displayStatus":"error",""" +
                    """"errorSummary":"Timed out","attempt":1}]}""",
            )
        }

        val rows = (repository.projectRuns("proj") as RepositoryResult.Content).value

        assertEquals("proj", requests.single().url.parameters["projectItemId"])
        assertEquals("20", requests.single().url.parameters["limit"])
        assertEquals(SempRunTrigger.TICK, rows[0].trigger)
        assertEquals("m1", rows[0].messageId)
        assertEquals(SempRunStatus.ERROR, rows[1].status)
        assertEquals("Timed out", rows[1].errorSummary)
    }

    @Test
    fun `a retry posts to the run and a run that is gone is not found`() = runTest {
        val repository = repository { json("""{"jobKey":"k"}""", HttpStatusCode.Accepted) }
        assertEquals(RepositoryResult.Content(Unit), repository.retry("r1"))
        assertEquals(HttpMethod.Post, requests.single().method)
        assertEquals("/api/agent-runs/r1/retry", requests.single().url.encodedPath)

        val gone = repository { json("{}", HttpStatusCode.NotFound) }
        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), gone.retry("r9"))
    }
}
