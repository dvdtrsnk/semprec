package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SempDriftChoice
import cz.alldots.app.domain.SempDriftKind
import cz.alldots.app.domain.SempGuidance
import cz.alldots.app.domain.SempGuidanceSave
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
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val GUIDANCE =
    """{"sections":{"purpose":"Help","allowed":"- read","notAllowed":"","generalInstructions":"Czech"},""" +
        """"updatedAt":"2026-10-21T08:00:00.000Z","ownerUserId":"u"}"""

class HttpSempProjectAgentRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpSempProjectAgentRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpSempProjectAgentRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun `the name of the project is read from its item`() = runTest {
        val repository = repository { json("""{"id":"p1","properties":{"name":"Alldots iOS","status":"active"}}""") }

        assertEquals(RepositoryResult.Content<String?>("Alldots iOS"), repository.projectName("p1"))
        assertEquals("/api/items/p1", requests.single().url.encodedPath)
    }

    @Test
    fun `the guidance is read as four parts with its version`() = runTest {
        val document = (repository { json(GUIDANCE) }.guidance("p1") as RepositoryResult.Content).value

        assertEquals("/api/projects/p1/agent-guidance", requests.single().url.encodedPath)
        assertEquals(SempGuidance("Help", "- read", "", "Czech"), document.guidance)
        assertEquals("2026-10-21T08:00:00.000Z", document.updatedAt)
    }

    @Test
    fun `saving puts the four parts with the version they were read at`() = runTest {
        val repository = repository { json(GUIDANCE) }

        val saved = repository.saveGuidance("p1", SempGuidance("Help", "- read", "", "Czech"), "v0")

        assertEquals(HttpMethod.Put, requests.single().method)
        assertEquals(
            """{"sections":{"purpose":"Help","allowed":"- read","notAllowed":"","generalInstructions":"Czech"},""" +
                """"expectedUpdatedAt":"v0"}""",
            bodies.single(),
        )
        val savedDocument = assertIs<SempGuidanceSave.Saved>((saved as RepositoryResult.Content).value).document
        assertEquals("2026-10-21T08:00:00.000Z", savedDocument.updatedAt)
    }

    @Test
    fun `a first save names no version with an explicit null`() = runTest {
        repository { json(GUIDANCE) }.saveGuidance("p1", SempGuidance("Help", "", "", ""), null)

        assertTrue(bodies.single().endsWith(""""expectedUpdatedAt":null}"""))
    }

    @Test
    fun `saving a guidance that changed meanwhile answers the newer one`() = runTest {
        val repository = repository { request ->
            if (request.method == HttpMethod.Put) json("{}", HttpStatusCode.Conflict) else json(GUIDANCE)
        }

        val result = repository.saveGuidance("p1", SempGuidance("", "", "", ""), "old")

        val conflict = assertIs<SempGuidanceSave.Conflict>((result as RepositoryResult.Content).value)
        assertEquals("Help", conflict.current.guidance.purpose)
        assertEquals(listOf(HttpMethod.Put, HttpMethod.Get), requests.map { it.method })
    }

    @Test
    fun `a refused save that is no conflict stays a failure`() = runTest {
        val repository = repository { json("{}", HttpStatusCode.Forbidden) }

        val result = repository.saveGuidance("p1", SempGuidance("", "", "", ""), null)

        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), result)
    }

    @Test
    fun `the drift lists its findings with the lines Semp suggests`() = runTest {
        val repository = repository {
            json(
                """{"guidanceUpdatedAt":"v1","findings":[{"id":"f1","kind":"behavior","claim":"Creates tasks",""" +
                    """"severity":"warning","firstSeenAt":"t","evidence":{"runIds":["r"],"count":3},""" +
                    """"suggestedAllowedLine":"Create tasks","suggestedNotAllowedLine":"Never create tasks"},""" +
                    """{"id":"f2","kind":"permission","claim":"Cannot delete","severity":"blocking",""" +
                    """"firstSeenAt":"t",""" +
                    """"evidence":{"guidanceExcerpt":"x","manifestFacts":[]},"suggestedAllowedLine":null,""" +
                    """"suggestedNotAllowedLine":null},""" +
                    """{"id":"f3","kind":"mystery","claim":"?","severity":"warning"}]}""",
            )
        }

        val drift = (repository.drift("p1") as RepositoryResult.Content).value

        assertEquals("v1", drift.guidanceUpdatedAt)
        assertEquals(listOf("f1", "f2"), drift.findings.map { it.id })
        assertEquals(SempDriftKind.BEHAVIOR, drift.findings[0].kind)
        assertEquals("Create tasks", drift.findings[0].suggestedAllowedLine)
        assertTrue(drift.findings[1].blocking)
        assertNull(drift.findings[1].suggestedAllowedLine)
    }

    @Test
    fun `resolving a finding posts the choice with the guidance version and answers the new guidance`() = runTest {
        val repository = repository {
            json(
                """{"finding":{"id":"f1","status":"resolved"},"guidance":{"sections":{"purpose":"P","allowed":"",""" +
                    """"notAllowed":"","generalInstructions":""},"updatedAt":"v2"}}""",
            )
        }

        val result = repository.resolveDrift("p1", "f1", SempDriftChoice.ALLOW, "v1")

        assertEquals("/api/agent-guidance-drift/f1/resolve", requests.single().url.encodedPath)
        assertEquals("""{"choice":"allow","expectedGuidanceUpdatedAt":"v1"}""", bodies.single())
        val resolved = assertIs<SempGuidanceSave.Saved>((result as RepositoryResult.Content).value).document
        assertEquals("v2", resolved.updatedAt)
    }

    @Test
    fun `resolving against a guidance that changed meanwhile answers the newer one`() = runTest {
        val repository = repository { request ->
            if (request.method == HttpMethod.Post) json("{}", HttpStatusCode.Conflict) else json(GUIDANCE)
        }

        val result = repository.resolveDrift("p1", "f1", SempDriftChoice.DISMISS, "old")

        assertIs<SempGuidanceSave.Conflict>((result as RepositoryResult.Content).value)
        assertEquals("/api/projects/p1/agent-guidance", requests.last().url.encodedPath)
    }

    @Test
    fun `the tools list shows the label of each and whether it is granted`() = runTest {
        val repository = repository {
            json(
                """{"rows":[{"mcpToolRegistrationId":"g1","toolName":"create_issue","description":null,""" +
                    """"displayLabel":"Create issues","requiresApproval":true,"riskClass":"write",""" +
                    """"mcpServerItemId":"s1",""" +
                    """"mcpServerName":"GitHub","mcpServerOnline":true,"granted":true,"effective":true},""" +
                    """{"mcpToolRegistrationId":"g2","toolName":"web_search","requiresApproval":false,""" +
                    """"mcpServerItemId":"s2","mcpServerName":"Web","granted":false}],""" +
                    """"counts":{"effective":1,"total":2}}""",
            )
        }

        val grants = (repository.grants("p1") as RepositoryResult.Content).value

        assertEquals("/api/projects/p1/mcp-grants", requests.single().url.encodedPath)
        assertEquals("Create issues", grants[0].label)
        assertTrue(grants[0].requiresApproval && grants[0].granted && grants[0].serverOnline)
        assertEquals("web_search", grants[1].label)
        assertTrue(!grants[1].serverOnline && !grants[1].granted)
    }

    @Test
    fun `a grant and an automatic task are switched with a patch`() = runTest {
        val repository = repository { json("{}") }

        repository.setGrant("p1", "g1", true)
        repository.setTaskEnabled("h1", false)
        repository.runTask("h1")

        assertEquals(
            listOf("/api/projects/p1/mcp-grants/g1", "/api/heartbeats/h1", "/api/heartbeats/h1/trigger"),
            requests.map { it.url.encodedPath },
        )
        assertEquals(listOf(HttpMethod.Patch, HttpMethod.Patch, HttpMethod.Post), requests.map { it.method })
        assertEquals("""{"granted":true}""", bodies[0])
        assertEquals("""{"enabled":false}""", bodies[1])
    }

    @Test
    fun `the tasks map their rule their thread and how the last run went`() = runTest {
        val repository = repository {
            json(
                """{"rows":[{"id":"h1","name":"Morning","rule":{"kind":"cron"},"ruleLabel":"Mon-Fri 8:30",""" +
                    """"enabled":true,""" +
                    """"nextFireAt":null,"lastOccurrence":{"at":"t1","status":"ok","errorSummary":null},""" +
                    """"threadId":"th"},""" +
                    """{"id":"h2","name":"Backlog","ruleLabel":"Fridays","enabled":false,"lastOccurrence":""" +
                    """{"at":"t2","status":"failed","errorSummary":"GitHub down"},"threadId":null},""" +
                    """{"id":"h3","name":"Issues","ruleLabel":"On issue","enabled":true,"lastOccurrence":""" +
                    """{"at":"t3","status":"waiting_approval","errorSummary":null}},""" +
                    """{"id":"h4","name":"New","ruleLabel":"Daily","enabled":true,"lastOccurrence":null}]}""",
            )
        }

        val tasks = (repository.tasks("p1") as RepositoryResult.Content).value

        assertEquals("/api/projects/p1/heartbeats", requests.single().url.encodedPath)
        assertEquals("th", tasks[0].threadId)
        assertTrue(!tasks[0].lastFailed && !tasks[0].lastWaiting)
        assertTrue(tasks[1].lastFailed)
        assertEquals("GitHub down", tasks[1].lastErrorSummary)
        assertTrue(tasks[2].lastWaiting)
        assertNull(tasks[3].lastAt)
    }
}
