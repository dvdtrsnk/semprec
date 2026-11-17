package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SempProblemAction
import cz.semprec.app.domain.SempProblemSeverity
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val STATUS_BODY =
    """{"activeCount":2,"services":[""" +
        """{"key":"agents","name":"Semp and agents","state":"error","since":"2026-10-21T07:12:00.000Z",""" +
        """"lastActivityAt":"2026-10-21T11:05:00.000Z","detail":null},""" +
        """{"key":"backup","name":"Backups","state":"ok","since":null,"lastActivityAt":null,"detail":null}],""" +
        """"problems":[""" +
        """{"id":"p1","category":"agents","severity":"critical","title":"Semp did not finish","text":"Timed out.",""" +
        """"shortText":"Timed out","since":"2026-10-21T09:05:00.000Z","mergedCount":4,"projectName":"Semprec iOS",""" +
        """"source":{"table":"agent_runs","id":"r"},"affectedService":"agents","actions":[""" +
        """{"kind":"retryRun","target":"run-1"},{"kind":"openThread","target":"th-1"},""" +
        """{"kind":"retryPrompt","target":"msg-1"},""" +
        """{"kind":"openChat","target":{"threadId":"th-2","messageId":"msg-1"}},""" +
        """{"kind":"disableHeartbeat","target":"hb-1"},{"kind":"openProject","target":"pr-1"},""" +
        """{"kind":"reauthMailbox","target":"mb-1"},{"kind":"retryTranscription","target":"tr-1"},""" +
        """{"kind":"openChat","target":"not-an-object"}]},""" +
        """{"id":"p2","category":"mail","severity":"warning","title":"Mail",""" +
        """"text":"Sign-in expired","shortText":"s",""" +
        """"since":null,"projectName":null,"actions":[{"kind":"reauthMailbox","target":"mb-1"}]}],""" +
        """"resolvedRecent":[{"id":"x1","category":"agents","resolutionTitle":"Queue is empty",""" +
        """"resolvedAt":"2026-10-20T16:40:00.000Z"}]}"""

class HttpSempStatusRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun repository(body: String, status: HttpStatusCode = HttpStatusCode.OK): HttpSempStatusRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val engine = MockEngine { request ->
            requests += request
            respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return HttpSempStatusRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    @Test
    fun `the report maps the services the problems with their usable actions and the resolved ones`() = runTest {
        val report = (repository(STATUS_BODY).report() as RepositoryResult.Content).value

        assertEquals("/api/semp-status", requests.single().url.encodedPath)
        assertEquals(2, report.activeCount)
        assertEquals("2026-10-21T07:12:00.000Z", report.services[0].failingSince)
        assertNull(report.services[1].failingSince)
        val problem = report.problems[0]
        assertEquals(SempProblemSeverity.CRITICAL, problem.severity)
        assertEquals(4, problem.mergedCount)
        assertEquals("Semprec iOS", problem.projectName)
        assertEquals(
            listOf(
                SempProblemAction.RetryRun("run-1"),
                SempProblemAction.OpenThread("th-1"),
                SempProblemAction.RetryPrompt("th-2", "msg-1"),
                SempProblemAction.OpenChat("th-2", "msg-1"),
                SempProblemAction.DisableHeartbeat("hb-1"),
                SempProblemAction.OpenProject("pr-1"),
            ),
            problem.actions,
        )
        assertEquals(SempProblemSeverity.WARNING, report.problems[1].severity)
        assertEquals(emptyList(), report.problems[1].actions)
        assertEquals("Queue is empty", report.resolved.single().title)
    }

    @Test
    fun `the summary carries the count and the notice`() = runTest {
        val summary = (
            repository(
                """{"activeCount":3,"banner":{"problemId":"p","title":"Mail","shortText":"Not syncing",""" +
                    """"impactKey":"mailNotSyncing","instanceId":"p"}}""",
            ).summary() as RepositoryResult.Content
            ).value

        assertEquals(3, summary.activeCount)
        assertEquals("p", summary.bannerProblemId)
        assertEquals("Mail", summary.bannerTitle)
        assertEquals("Not syncing", summary.bannerText)
    }

    @Test
    fun `a summary without a notice has none and a refused session is a failure`() = runTest {
        val summary = (repository("""{"activeCount":0,"banner":null}""").summary() as RepositoryResult.Content).value
        assertNull(summary.bannerProblemId)

        assertEquals(
            RepositoryResult.Failure(FailureKind.UNAUTHORIZED),
            repository("{}", HttpStatusCode.Forbidden).report(),
        )
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), repository("""{"x":1}""").report())
    }
}
