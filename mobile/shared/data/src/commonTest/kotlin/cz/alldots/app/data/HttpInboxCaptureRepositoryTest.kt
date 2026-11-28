package cz.alldots.app.data

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.InboxCapture
import cz.alldots.app.domain.InboxCaptureFile
import cz.alldots.app.domain.InboxCaptureSource
import cz.alldots.app.domain.InboxType
import cz.alldots.app.domain.RepositoryResult
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
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs

private const val CAPTURE_SERVER = "https://s.example"
private const val CAPTURE_BLOB = "0f8fad5b-d9cb-469f-a165-70867728950e"
private val CAPTURE_DAY = CalendarDay(2026, 11, 16)

class HttpInboxCaptureRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<ByteArray>()
    private var handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData = { answer(it) }

    private fun repository(): HttpInboxCaptureRepository {
        val storage = InMemorySessionStorage().apply { save(StoredSession(CAPTURE_SERVER, "tok")) }
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray()
            handler(request)
        }
        return HttpInboxCaptureRepository(AuthenticatedApi(ApiClient(engine), storage) {})
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun MockRequestHandleScope.answer(request: HttpRequestData): HttpResponseData =
        when (request.url.encodedPath) {
            "/api/inbox-types" -> json(
                """{"types":[{"id":"t1","label":"Task","emoji":"T","targetLabel":"Tasks","extra":1},""" +
                    """{"id":"t2","label":"Thought","emoji":"S"}]}""",
            )
            "/api/blobs" ->
                json("""{"blobId":"$CAPTURE_BLOB","byteSize":3,"mimeType":"image/png"}""", HttpStatusCode.Created)
            else -> json("""{"item":{"id":"i1"},"attachments":[]}""", HttpStatusCode.Created)
        }

    private fun capture(text: String = "Call the plumber", typeId: String? = null, file: InboxCaptureFile? = null) =
        InboxCapture(text, CAPTURE_DAY, "08:15", typeId, file)

    private fun sentJson(index: Int) = Json.parseToJsonElement(bodies[index].decodeToString()).jsonObject

    @Test
    fun theTypesAreReadInTheServersOrder() = runTest {
        val types = assertIs<RepositoryResult.Content<List<InboxType>>>(repository().types()).value

        assertEquals(
            listOf(InboxType("t1", "Task", "T", "Tasks"), InboxType("t2", "Thought", "S", null)),
            types,
        )
        assertEquals("/api/inbox-types", requests.single().url.encodedPath)
    }

    @Test
    fun aTextIsCapturedInOneRequestWithItsDayTimeAndType() = runTest {
        assertIs<RepositoryResult.Content<Unit>>(repository().capture(capture(typeId = "t1")))

        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/inbox/items", request.url.encodedPath)
        val body = sentJson(0)
        assertEquals("Call the plumber", body.getValue("text").jsonPrimitive.content)
        assertEquals("2026-11-16", body.getValue("date").jsonPrimitive.content)
        assertEquals("08:15", body.getValue("time").jsonPrimitive.content)
        assertEquals("typed", body.getValue("captureChannel").jsonPrimitive.content)
        assertEquals("t1", body.getValue("typeId").jsonPrimitive.content)
        assertFalse("attachments" in body, "A capture without a file sends no attachments")
    }

    @Test
    fun withoutATypeTheCaptureSendsNone() = runTest {
        assertIs<RepositoryResult.Content<Unit>>(repository().capture(capture()))

        assertFalse("typeId" in sentJson(0))
    }

    @Test
    fun aFileIsUploadedFirstAndAttachedByItsBlob() = runTest {
        val file = InboxCaptureFile("receipt.png", "image/png", byteArrayOf(1, 2, 3), InboxCaptureSource.PHOTO_LIBRARY)

        assertIs<RepositoryResult.Content<Unit>>(repository().capture(capture(text = "", file = file)))

        assertEquals(listOf("/api/blobs", "/api/inbox/items"), requests.map { it.url.encodedPath })
        assertEquals("image/png", requests[0].body.contentType?.toString())
        assertEquals(listOf<Byte>(1, 2, 3), bodies[0].toList())
        val attachment = sentJson(1).getValue("attachments").jsonArray.single().jsonObject
        assertEquals(CAPTURE_BLOB, attachment.getValue("blobId").jsonPrimitive.content)
        assertEquals("photoLibrary", attachment.getValue("source").jsonPrimitive.content)
    }

    @Test
    fun theCameraAndTheFilesAreNamedAsTheServerExpects() = runTest {
        val sources = listOf(InboxCaptureSource.CAMERA, InboxCaptureSource.FILES).map { source ->
            requests.clear()
            bodies.clear()
            val file = InboxCaptureFile("a.pdf", "application/pdf", byteArrayOf(7), source)
            repository().capture(capture(file = file))
            sentJson(1).getValue("attachments").jsonArray.single().jsonObject.getValue("source").jsonPrimitive.content
        }

        assertEquals(listOf("camera", "files"), sources)
    }

    @Test
    fun aRefusedUploadSendsNoCapture() = runTest {
        handler = { request ->
            if (request.url.encodedPath == "/api/blobs") json("""{"error":{}}""", HttpStatusCode.UnsupportedMediaType)
            else answer(request)
        }
        val file = InboxCaptureFile("a.exe", "application/octet-stream", byteArrayOf(9), InboxCaptureSource.FILES)

        val result = repository().capture(capture(file = file))

        assertIs<RepositoryResult.Failure>(result)
        assertEquals(listOf("/api/blobs"), requests.map { it.url.encodedPath })
    }

    @Test
    fun aRefusedCaptureIsItsFailure() = runTest {
        handler = { json("""{"error":{"code":"validation_failed"}}""", HttpStatusCode.BadRequest) }

        val result = repository().capture(capture())

        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
