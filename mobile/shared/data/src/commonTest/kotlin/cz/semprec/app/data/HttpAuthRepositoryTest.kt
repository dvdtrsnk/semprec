package cz.semprec.app.data

import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SessionStatus
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val DEVICE =
    DeviceInfo(AppPlatform.IOS, "11111111-1111-4111-8111-111111111111", "Test iPhone", "iphone", "26.0", "1.0")
private const val USER_JSON = """{"id":"u1","email":"a@b.cz","locale":"cs","createdAt":"2026-01-01","role":"member"}"""

class HttpAuthRepositoryTest {
    private val requests = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()

    private fun repository(
        storage: InMemorySessionStorage = InMemorySessionStorage(),
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpAuthRepository {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpAuthRepository(ApiClient(engine), storage, DEVICE)
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    @Test
    fun signInSendsTheDeviceAndStoresTheTokenOfTheAnswer() = runTest {
        val storage = InMemorySessionStorage()
        val repo = repository(storage) { json("""{"token":"tok","user":$USER_JSON}""") }

        val result = repo.signIn("https://s.example", "a@b.cz", "secret")

        val session = assertIs<RepositoryResult.Content<*>>(result).value
        assertEquals("https://s.example", (session as cz.semprec.app.domain.Session).serverUrl)
        assertEquals(StoredSession("https://s.example", "tok"), storage.load())
        assertIs<SessionStatus.SignedIn>(repo.status.value)
        assertEquals(HttpMethod.Post, requests.single().method)
        assertEquals("https://s.example/api/auth/login", requests.single().url.toString())
        val sent: JsonObject = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("ios", sent.getValue("platform").jsonPrimitive.content)
        assertEquals("iphone", sent.getValue("deviceKind").jsonPrimitive.content)
        assertEquals(DEVICE.deviceId, sent.getValue("deviceId").jsonPrimitive.content)
    }

    @Test
    fun theDisplayNameOfTheAccountIsKeptAndABlankOrMissingOneIsNone() = runTest {
        val named = """{"id":"u1","email":"a@b.cz","locale":"cs","role":"member","displayName":"Jana Dvořák"}"""
        val blank = """{"id":"u1","email":"a@b.cz","locale":"cs","role":"member","displayName":" "}"""
        val unnamed = """{"id":"u1","email":"a@b.cz","locale":"cs","role":"member","displayName":null}"""
        val names = listOf(named, blank, unnamed, USER_JSON).map { user ->
            val repo = repository { json("""{"token":"tok","user":$user}""") }
            val session = assertIs<RepositoryResult.Content<cz.semprec.app.domain.Session>>(
                repo.signIn("https://s.example", "a@b.cz", "secret"),
            ).value
            session.user.displayName
        }

        assertEquals(listOf("Jana Dvořák", null, null, null), names)
    }

    @Test
    fun aRefusedPasswordIsUnauthorizedAndStoresNothing() = runTest {
        val storage = InMemorySessionStorage()
        val repo = repository(storage) { json("""{"error":"no"}""", HttpStatusCode.Unauthorized) }

        val result = repo.signIn("https://s.example", "a@b.cz", "bad")

        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(result).kind)
        assertNull(storage.load())
        assertEquals(SessionStatus.Restoring, repo.status.value)
    }

    @Test
    fun aMalformedLoginAnswerIsInvalidData() = runTest {
        val repo = repository { json("""{"unexpected":true}""") }

        val result = repo.signIn("https://s.example", "a@b.cz", "secret")

        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test
    fun anUnreachableServerIsUnavailable() = runTest {
        val repo = repository { throw IllegalStateException("offline") }

        val result = repo.signIn("https://s.example", "a@b.cz", "secret")

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test
    fun restoreWithNothingStoredIsSignedOutWithoutARequest() = runTest {
        val repo = repository { error("no request expected") }

        repo.restore()

        assertEquals(SessionStatus.SignedOut, repo.status.value)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun restoreChecksTheStoredTokenAndSignsIn() = runTest {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val repo = repository(storage) { json("""{"user":$USER_JSON}""") }

        repo.restore()

        val status = assertIs<SessionStatus.SignedIn>(repo.status.value)
        assertEquals("a@b.cz", status.session.user.email)
        assertEquals("Bearer tok", requests.single().headers[HttpHeaders.Authorization])
    }

    @Test
    fun restoreWithARejectedTokenForgetsIt() = runTest {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "old")) }
        val repo = repository(storage) { json("{}", HttpStatusCode.Unauthorized) }

        repo.restore()

        assertEquals(SessionStatus.SignedOut, repo.status.value)
        assertNull(storage.load())
    }

    @Test
    fun restoreOfflineKeepsTheTokenAndReportsUnreachable() = runTest {
        val stored = StoredSession("https://s.example", "tok")
        val storage = InMemorySessionStorage().apply { save(stored) }
        val repo = repository(storage) { throw IllegalStateException("offline") }

        repo.restore()

        assertEquals(SessionStatus.Unreachable("https://s.example"), repo.status.value)
        assertEquals(stored, storage.load())
    }

    @Test
    fun signOutForgetsTheSessionEvenWhenTheServerCannotBeReached() = runTest {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val repo = repository(storage) { throw IllegalStateException("offline") }

        repo.signOut()

        assertNull(storage.load())
        assertEquals(SessionStatus.SignedOut, repo.status.value)
        assertEquals("https://s.example/api/auth/logout", requests.single().url.toString())
    }

    @Test
    fun anAuthenticatedCallRejectedWith401SignsTheDeviceOut() = runTest {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val repo = repository(storage) { json("{}", HttpStatusCode.Unauthorized) }

        val response = repo.api.send(HttpMethod.Get, "/api/overview")

        assertEquals(FailureKind.UNAUTHORIZED, assertIs<ApiResponse.Failure>(response).kind)
        assertNull(storage.load())
        assertEquals(SessionStatus.SignedOut, repo.status.value)
    }

    @Test
    fun anAuthenticatedCallWithoutASessionNeverReachesTheNetwork() = runTest {
        val repo = repository { error("no request expected") }

        val response = repo.api.send(HttpMethod.Get, "/api/overview")

        assertEquals(FailureKind.UNAUTHORIZED, assertIs<ApiResponse.Failure>(response).kind)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun requestPasswordResetPostsTheAddress() = runTest {
        val repo = repository { json("""{"ok":true}""") }

        val result = repo.requestPasswordReset("https://s.example", "a@b.cz")

        assertIs<RepositoryResult.Content<Unit>>(result)
        assertEquals("""{"email":"a@b.cz"}""", bodies.single())
    }

    @Test
    fun statusesMapToTheExpectedFailures() {
        assertNull(failureKind(HttpStatusCode.fromValue(204)))
        assertEquals(FailureKind.UNAUTHORIZED, failureKind(HttpStatusCode.fromValue(401)))
        assertEquals(FailureKind.UNAUTHORIZED, failureKind(HttpStatusCode.fromValue(403)))
        assertEquals(FailureKind.NOT_FOUND, failureKind(HttpStatusCode.fromValue(404)))
        assertEquals(FailureKind.REJECTED, failureKind(HttpStatusCode.fromValue(400)))
        assertEquals(FailureKind.REJECTED, failureKind(HttpStatusCode.fromValue(409)))
        assertEquals(FailureKind.UNAVAILABLE, failureKind(HttpStatusCode.fromValue(429)))
        assertEquals(FailureKind.UNAVAILABLE, failureKind(HttpStatusCode.fromValue(503)))
        assertEquals(FailureKind.INVALID_DATA, failureKind(HttpStatusCode.fromValue(302)))
    }
}
