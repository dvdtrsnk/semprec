package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempApprovalExecution
import cz.semprec.app.domain.SempApprovalRisk
import cz.semprec.app.domain.SempApprovalSource
import cz.semprec.app.domain.SempApprovalStatus
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val ROW =
    """{"id":"a1","toolName":"item.delete","riskClass":"destructive","riskLevel":"irreversible",""" +
        """"requestedAt":"2026-10-21T13:24:00.000Z","safeSummary":{"kind":"genericOperation",""" +
        """"operationName":"item.delete","argKeys":["databaseId","itemId"]},"agentRunId":"r1","projectItemId":"p",""" +
        """"projectName":"Finance","reason":null,"description":{"key":"approval.itemDelete","params":""" +
        """{"itemName":"Tax return","databaseName":"Tasks","linkedCount":2,"restorableDays":30,""" +
        """"projectName":null}},""" +
        """"breaksLinks":[{"itemId":"x"}],"endsInheritance":[],"source":{"kind":"chat","threadId":"th",""" +
        """"threadTitle":"Plan","heartbeatId":null,"heartbeatName":null,"mcpClientName":null}}"""

class HttpSempApprovalRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpSempApprovalRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpSempApprovalRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun `the pending queue asks for pending requests and maps a row with its description and source`() = runTest {
        val repository = repository { json("""{"rows":[$ROW],"nextCursor":"n"}""") }

        val page = (repository.list(pending = true, cursor = "c") as RepositoryResult.Content).value

        val request = requests.single()
        assertEquals("/api/approval-requests", request.url.encodedPath)
        assertEquals("pending", request.url.parameters["status"])
        assertEquals("c", request.url.parameters["cursor"])
        assertEquals("n", page.nextCursor)
        val row = page.rows.single()
        assertEquals(SempApprovalRisk.IRREVERSIBLE, row.risk)
        assertEquals(SempApprovalSource.CHAT, row.source)
        assertEquals("Plan", row.threadTitle)
        assertEquals("approval.itemDelete", row.description?.key)
        assertEquals("Tax return", row.description?.params?.get("itemName"))
        assertEquals("2", row.description?.params?.get("linkedCount"))
        assertNull(row.description?.params?.get("projectName"))
        assertEquals("item.delete", row.call.label)
        assertEquals(listOf("databaseId", "itemId"), row.call.argumentKeys)
        assertEquals("Finance", row.projectName)
        assertTrue(row.breaksLink)
        assertEquals(SempApprovalStatus.PENDING, row.status)
        assertEquals(SempApprovalExecution.NOT_RUN, row.execution)
    }

    @Test
    fun `the decided list maps how an approved request came out`() = runTest {
        val decided = ROW.dropLast(1) +
            ""","status":"approved","decidedAt":"t","executionStatus":"conflict","conflictReason":""" +
            """{"key":"approval.conflict.deleted"}}"""
        val repository = repository { json("""{"rows":[$decided],"nextCursor":null}""") }

        val row = (repository.list(pending = false, cursor = null) as RepositoryResult.Content).value.rows.single()

        assertEquals("decided", requests.single().url.parameters["status"])
        assertEquals(SempApprovalStatus.APPROVED, row.status)
        assertEquals(SempApprovalExecution.CONFLICT, row.execution)
        assertEquals("approval.conflict.deleted", row.conflictKey)
    }

    @Test
    fun `an mcp request names its server and tool and a row of an unknown source is skipped`() = runTest {
        val mcp = ROW.replace(
            """{"kind":"genericOperation","operationName":"item.delete","argKeys":["databaseId","itemId"]}""",
            """{"kind":"mcpInvoke","mcpServerName":"Gmail","mcpToolName":"send_email","argKeys":["to"]}""",
        ).replace(""""kind":"chat"""", """"kind":"mcp"""")
        val unknown = ROW.replace(""""kind":"chat"""", """"kind":"fax"""")
        val repository = repository { json("""{"rows":[$mcp,$unknown],"nextCursor":null}""") }

        val rows = (repository.list(pending = true, cursor = null) as RepositoryResult.Content).value.rows

        assertEquals(1, rows.size)
        assertEquals(SempApprovalSource.MCP, rows[0].source)
        assertEquals("Gmail - send_email", rows[0].call.label)
    }

    @Test
    fun `the count asks for pending requests`() = runTest {
        val repository = repository { json("""{"count":3}""") }

        assertEquals(RepositoryResult.Content(3), repository.pendingCount())
        assertEquals("/api/approval-requests/count", requests.single().url.encodedPath)
        assertEquals("pending", requests.single().url.parameters["status"])
    }

    @Test
    fun `one request is read by its id in whatever status it has`() = runTest {
        val repository = repository {
            json(ROW.dropLast(1) + ""","status":"approved","executionStatus":"succeeded"}""")
        }

        val row = (repository.get("a1") as RepositoryResult.Content).value

        assertEquals("/api/approval-requests/a1", requests.single().url.encodedPath)
        assertEquals(SempApprovalExecution.SUCCEEDED, row.execution)
    }

    @Test
    fun `a decision patches the request and answers it as it stands`() = runTest {
        val repository = repository {
            json(ROW.dropLast(1) + ""","status":"approved","executionStatus":"queued","outcome":"decided"}""")
        }

        val row = (repository.decide("a1", approve = true) as RepositoryResult.Content).value

        assertEquals(HttpMethod.Patch, requests.single().method)
        assertEquals("/api/approval-requests/a1", requests.single().url.encodedPath)
        assertEquals("""{"decision":"approved"}""", bodies.single())
        assertEquals(SempApprovalExecution.QUEUED, row.execution)
    }

    @Test
    fun `a rejection says rejected and a request that is gone is not found`() = runTest {
        val repository = repository { json("{}", HttpStatusCode.NotFound) }

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), repository.decide("a1", approve = false))
        assertEquals("""{"decision":"rejected"}""", bodies.single())
    }
}
