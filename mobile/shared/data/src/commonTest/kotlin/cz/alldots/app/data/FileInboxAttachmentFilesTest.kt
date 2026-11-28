package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.InboxAttachmentLocation
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureFile
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SessionUser
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val ATTACHMENT_SESSION = StoredSession("https://s.example", "tok")
private val ATTACHMENT_PERSON = SessionUser("u1", "ada@example.com", "en", "member")
private val PDF_BYTES = byteArrayOf(0x25, 0x50, 0x44, 0x46)
private val BLOB = InboxAttachmentLocation.Blob("b1")

/** The files of Inbox attachments: downloaded once into the cache directory, or copied from the outbox. */
@OptIn(ExperimentalCoroutinesApi::class)
class FileInboxAttachmentFilesTest {
    private val cache = newTestDirectory()
    private val data = newTestDirectory()
    private val requests = mutableListOf<String>()
    private var reachable = true
    private var body: ByteArray = PDF_BYTES
    private var status = HttpStatusCode.OK
    private val storage = InMemorySessionStorage().apply { save(ATTACHMENT_SESSION) }

    private val engine = MockEngine { request ->
        if (!reachable) error("no network")
        requests += "${request.method.value} ${request.url.encodedPath}"
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/pdf"))
    }

    private fun TestScope.files(
        offline: OfflineLayer? = null,
        directory: String? = cache,
    ): FileInboxAttachmentFiles {
        val api = AuthenticatedApi(ApiClient(engine), storage, offline = offline) {}
        return FileInboxAttachmentFiles(directory, api, StandardTestDispatcher(testScheduler))
    }

    /** Adds a capture with a PDF to the outbox of [layer] and answers its id. */
    private suspend fun waitingCapture(layer: OfflineLayer): String {
        layer.store.people.keep(accountKey(ATTACHMENT_SESSION), ATTACHMENT_PERSON)
        val file = InboxCaptureFile("scan.pdf", "application/pdf", PDF_BYTES, InboxCaptureSource.CAMERA)
        val capture = InboxCapture("Pay the plumber", CalendarDay(2026, 11, 28), "08:15", null, file)
        assertEquals(RepositoryResult.Content(Unit), layer.captures.add(ATTACHMENT_SESSION, capture))
        return layer.captures.waitingOf(ATTACHMENT_SESSION).single().id
    }

    private fun RepositoryResult<String>.path(): String = assertIs<RepositoryResult.Content<String>>(this).value

    @Test fun `a server attachment is downloaded into the cache under its file name`() = runTest {
        val path = files().file(BLOB, "Invoice.pdf").path()

        assertEquals(listOf("GET /api/blobs/b1"), requests)
        assertTrue(path.startsWith("$cache/inbox-attachments/"))
        assertTrue(path.endsWith("/blobs/b1/Invoice.pdf"))
        assertContentEquals(PDF_BYTES, readCacheBytes(path))
    }

    @Test fun `a second open answers the file downloaded before without a request and also offline`() = runTest {
        val first = files().file(BLOB, "Invoice.pdf").path()
        reachable = false

        val second = files().file(BLOB, "Invoice.pdf").path()

        assertEquals(first, second)
        assertEquals(listOf("GET /api/blobs/b1"), requests, "the file is downloaded once")
    }

    @Test fun `offline an attachment never downloaded fails as unavailable and writes nothing`() = runTest {
        reachable = false

        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), files().file(BLOB, "Invoice.pdf"))
        assertEquals(emptyList(), listCacheDirectory("$cache/inbox-attachments"))
    }

    @Test fun `a refused download fails with its kind and writes nothing`() = runTest {
        status = HttpStatusCode.NotFound

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), files().file(BLOB, "Invoice.pdf"))
        assertEquals(emptyList(), listCacheDirectory("$cache/inbox-attachments"))
    }

    @Test fun `a download longer than its bound is not read`() = runTest {
        val client = ApiClient(engine)

        val refused = client.download("https://s.example", "/api/blobs/b1", "tok", maxBytes = 3)
        val read = client.download("https://s.example", "/api/blobs/b1", "tok", maxBytes = 4)

        assertEquals(ApiBytesResponse.Failure(FailureKind.INVALID_DATA, 200), refused)
        assertContentEquals(PDF_BYTES, assertIs<ApiBytesResponse.Success>(read).bytes)
    }

    @Test fun `an id that is not a plain id never becomes a path`() = runTest {
        val files = files()
        listOf(InboxAttachmentLocation.Blob("../b1"), InboxAttachmentLocation.WaitingCapture("a/b")).forEach {
            assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), files.file(it, "Invoice.pdf"))
        }
        assertEquals(emptyList(), requests)
    }

    @Test fun `a file name that is not one plain file name never becomes a path`() = runTest {
        // The attachments live one level below `cache`, so a name that climbed out of them would land in `cache`.
        val layer = OfflineLayer(OfflineStore(data, StandardTestDispatcher(testScheduler)), backgroundScope)
        val captureId = waitingCapture(layer)
        val files = files(layer, directory = "$cache/app")
        val names = listOf("../x.pdf", "a/b.pdf", "a\\b.pdf", "../../../../../escape.pdf", "..", ".", "", "x\u0000.pdf")
        val locations = listOf(BLOB, InboxAttachmentLocation.WaitingCapture(captureId))

        names.forEach { name ->
            locations.forEach { location ->
                val result = files.file(location, name)
                assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), result, "$location '$name'")
            }
        }

        assertEquals(emptyList(), requests)
        assertEquals(emptyList(), listCacheDirectory(cache), "nothing is written inside or outside the cache")
    }

    @Test fun `a file name the sanitizer keeps opens with spaces and diacritics`() = runTest {
        val path = files().file(BLOB, "Faktura č. 12.pdf").path()

        assertTrue(path.endsWith("/blobs/b1/Faktura č. 12.pdf"))
        assertContentEquals(PDF_BYTES, readCacheBytes(path))
    }

    @Test fun `without a cache directory or a session nothing is opened`() = runTest {
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), files(directory = null).file(BLOB, "a.pdf"))
        storage.save(null)
        assertEquals(RepositoryResult.Failure(FailureKind.UNAUTHORIZED), files().file(BLOB, "a.pdf"))
        assertEquals(emptyList(), requests)
    }

    @Test fun `the file of a waiting capture is copied from the outbox while offline`() = runTest {
        reachable = false
        val layer = OfflineLayer(OfflineStore(data, StandardTestDispatcher(testScheduler)), backgroundScope)
        val captureId = waitingCapture(layer)

        val path = files(layer).file(InboxAttachmentLocation.WaitingCapture(captureId), "scan.pdf").path()

        assertTrue(path.startsWith("$cache/inbox-attachments/"))
        assertTrue(path.endsWith("/captures/$captureId/scan.pdf"))
        assertContentEquals(PDF_BYTES, readCacheBytes(path))
        assertEquals(emptyList(), requests)
    }

    @Test fun `a capture no longer in the outbox is not found`() = runTest {
        val layer = OfflineLayer(OfflineStore(data, StandardTestDispatcher(testScheduler)), backgroundScope)
        layer.store.people.keep(accountKey(ATTACHMENT_SESSION), ATTACHMENT_PERSON)

        val result = files(layer).file(InboxAttachmentLocation.WaitingCapture("c1"), "scan.pdf")

        assertEquals(RepositoryResult.Failure(FailureKind.NOT_FOUND), result)
    }

    @Test fun `clearing deletes every attachment file`() = runTest {
        val files = files()
        val path = files.file(BLOB, "Invoice.pdf").path()

        files.clear()

        assertNull(readCacheBytes(path))
        assertEquals(emptyList(), listCacheDirectory("$cache/inbox-attachments"))
    }
}
