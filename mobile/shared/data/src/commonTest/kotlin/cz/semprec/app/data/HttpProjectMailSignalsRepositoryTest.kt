package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailSignalField
import cz.semprec.app.domain.MailSignalAssignment
import cz.semprec.app.domain.MailSignalPerson
import cz.semprec.app.domain.MailSignalPreview
import cz.semprec.app.domain.MailSignalSet
import cz.semprec.app.domain.MailSignalsOutcome
import cz.semprec.app.domain.ProjectMailSignals
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private const val SIGNALS = """{"projectId":"p1","domains":["novak.cz"],"addresses":["petr@pekarna.cz"],""" +
    """"keywords":["Faktura"],"updatedAt":"2026-11-20T10:00:00.000Z","peopleAddresses":""" +
    """[{"personId":"u1","name":"Petr Novák","address":"petr@novak.cz"},{"personId":"u2","address":"x@y.cz"}],""" +
    """"extra":1}"""

private const val THREAD = """{"threadId":"t1","subject":"Faktura za březen",""" +
    """"lastMessageAt":"2026-11-19T08:00:00Z",""" +
    """"lastSender":{"name":"Petr Novák","address":"petr@novak.cz"},"messageCount":2}"""

private val SAVED = ProjectMailSignals(
    projectId = "p1",
    signals = MailSignalSet(listOf("novak.cz"), listOf("petr@pekarna.cz"), listOf("Faktura")),
    updatedAt = "2026-11-20T10:00:00.000Z",
    people = listOf(MailSignalPerson("u1", "Petr Novák", "petr@novak.cz"), MailSignalPerson("u2", "", "x@y.cz")),
)

private fun invalid(field: String) = HttpStatusCode.BadRequest to
    """{"error":{"code":"validation_failed","details":{"field":"$field"}}}"""

class HttpProjectMailSignalsRepositoryTest {

    @Test fun `the signals are read with the addresses of the project's people`() = runTest {
        val server = MailTestServer { ok(SIGNALS) }

        val result = HttpProjectMailSignalsRepository(server.api()).signals("p1")

        assertEquals(RepositoryResult.Content(SAVED), result)
        assertEquals(HttpMethod.Get, server.requests.single().method)
        assertEquals("/api/mail/projects/p1/signals", server.requests.single().url.encodedPath)
    }

    @Test fun `a project that was never set up reads as empty lists without a time`() = runTest {
        val server = MailTestServer { ok("""{"projectId":"p1","updatedAt":null}""") }

        val result = HttpProjectMailSignalsRepository(server.api()).signals("p1")

        assertEquals(RepositoryResult.Content(ProjectMailSignals("p1", MailSignalSet(), null, emptyList())), result)
    }

    @Test fun `a read the server refuses or answers unreadably is a failure`() = runTest {
        val cases = listOf(
            (HttpStatusCode.NotFound to """{"error":{"code":"not_found"}}""") to FailureKind.NOT_FOUND,
            (HttpStatusCode.InternalServerError to "{}") to FailureKind.UNAVAILABLE,
            ok("""{"domains":[]}""") to FailureKind.INVALID_DATA,
        )
        cases.forEach { (answer, kind) ->
            val result = HttpProjectMailSignalsRepository(MailTestServer { answer }.api()).signals("p1")
            assertEquals(RepositoryResult.Failure(kind), result, "$answer")
        }
    }

    @Test fun `saving puts every list including an empty one and answers the saved signals`() = runTest {
        val server = MailTestServer { ok(SIGNALS) }

        val result = HttpProjectMailSignalsRepository(server.api())
            .save("p1", MailSignalSet(domains = listOf("novak.cz")))

        assertEquals(RepositoryResult.Content(MailSignalsOutcome.Done(SAVED)), result)
        assertEquals(HttpMethod.Put, server.requests.single().method)
        assertEquals("/api/mail/projects/p1/signals", server.requests.single().url.encodedPath)
        assertEquals("""{"domains":["novak.cz"],"addresses":[],"keywords":[]}""", server.bodies.single())
    }

    @Test fun `a save or a preview refused for one list names that list`() = runTest {
        val fields = mapOf(
            "domains" to MailSignalField.DOMAINS,
            "addresses" to MailSignalField.ADDRESSES,
            "keywords" to MailSignalField.KEYWORDS,
        )
        fields.forEach { (wire, field) ->
            val repository = HttpProjectMailSignalsRepository(MailTestServer { invalid(wire) }.api())
            val expected = RepositoryResult.Content(MailSignalsOutcome.Invalid(field))
            assertEquals(expected, repository.save("p1", MailSignalSet()), wire)
            assertEquals(expected, repository.preview("p1", MailSignalSet()), wire)
        }
    }

    @Test fun `a refusal that names no list is a rejected request`() = runTest {
        val answers = listOf(
            invalid("draft"),
            invalid("signals"),
            HttpStatusCode.BadRequest to """{"error":{"code":"validation_failed"}}""",
            HttpStatusCode.BadRequest to """{"error":{"code":"other","details":{"field":"domains"}}}""",
            HttpStatusCode.BadRequest to "not json",
            HttpStatusCode.Conflict to "{}",
        )
        answers.forEach { answer ->
            val repository = HttpProjectMailSignalsRepository(MailTestServer { answer }.api())
            val rejected = RepositoryResult.Failure(FailureKind.REJECTED)
            assertEquals(rejected, repository.save("p1", MailSignalSet()), "$answer")
            assertEquals(rejected, repository.preview("p1", null), "$answer")
        }
    }

    @Test fun `a preview of a draft sends the draft and reads the matching threads`() = runTest {
        val server = MailTestServer { ok("""{"total":3,"alreadyAssigned":1,"threads":[$THREAD]}""") }
        val draft = MailSignalSet(keywords = listOf("faktura"))

        val result = HttpProjectMailSignalsRepository(server.api()).preview("p1", draft)

        val preview = assertIs<MailSignalsOutcome.Done<MailSignalPreview>>(
            assertIs<RepositoryResult.Content<MailSignalsOutcome<MailSignalPreview>>>(result).value,
        ).value
        assertEquals(3, preview.total)
        assertEquals(1, preview.alreadyAssigned)
        val thread = preview.threads.single()
        assertEquals(
            listOf("t1", "Faktura za březen", "Petr Novák", "petr@novak.cz", "2026-11-19T08:00:00Z"),
            listOf(thread.threadId, thread.subject, thread.senderName, thread.senderAddress, thread.lastMessageAt)
        )
        assertEquals(HttpMethod.Post, server.requests.single().method)
        assertEquals("/api/mail/projects/p1/signals/preview", server.requests.single().url.encodedPath)
        assertEquals("""{"draft":{"domains":[],"addresses":[],"keywords":["faktura"]}}""", server.bodies.single())
    }

    @Test fun `a preview of the saved signals sends no draft`() = runTest {
        val server = MailTestServer { ok("""{"total":0,"alreadyAssigned":0,"threads":[]}""") }

        val result = HttpProjectMailSignalsRepository(server.api()).preview("p1", null)

        val preview = assertIs<MailSignalsOutcome.Done<MailSignalPreview>>(
            assertIs<RepositoryResult.Content<MailSignalsOutcome<MailSignalPreview>>>(result).value,
        ).value
        assertEquals(0, preview.total)
        assertEquals(emptyList(), preview.threads)
        assertEquals("{}", server.bodies.single())
    }

    @Test fun `applying posts the thread ids and reads what was assigned`() = runTest {
        val server = MailTestServer { ok("""{"assigned":2,"skipped":1}""") }

        val result = HttpProjectMailSignalsRepository(server.api()).apply("p1", listOf("t1", "t2", "t3"))

        assertEquals(RepositoryResult.Content(MailSignalAssignment(assigned = 2, skipped = 1)), result)
        assertEquals(HttpMethod.Post, server.requests.single().method)
        assertEquals("/api/mail/projects/p1/signals/apply", server.requests.single().url.encodedPath)
        assertEquals("""{"threadIds":["t1","t2","t3"]}""", server.bodies.single())
    }

    @Test fun `an apply the server refuses is a failure`() = runTest {
        val server = MailTestServer { invalid("threadIds") }

        val result = HttpProjectMailSignalsRepository(server.api()).apply("p1", listOf("t1"))

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), result)
    }
}
