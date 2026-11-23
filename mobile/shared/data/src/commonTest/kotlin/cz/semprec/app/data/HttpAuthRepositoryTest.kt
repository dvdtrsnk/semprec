package cz.semprec.app.data

import cz.semprec.app.core.AppPlatform
import cz.semprec.app.core.DeviceInfo
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.MailThreadList
import cz.semprec.app.domain.MailThreadQuery
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.RevokePushSubscription
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
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
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
        sessionEnded: suspend () -> Unit = {},
        endingSession: suspend (AuthenticatedApi) -> Unit = {},
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpAuthRepository {
        val engine = MockEngine { request ->
            requests += request
            bodies += request.body.toByteArray().decodeToString()
            handler(request)
        }
        return HttpAuthRepository(ApiClient(engine), storage, DEVICE, sessionEnded, endingSession)
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private val directory = newTestDirectory()

    /** A layer over the test's directory; another one created later finds what this one kept. */
    private fun TestScope.layer() =
        OfflineLayer(OfflineStore(directory, StandardTestDispatcher(testScheduler)), backgroundScope)

    /** A repository with [layer], wired as `HomeSDK` wires it: the end of a session clears the layer. */
    private fun offlineRepository(
        storage: InMemorySessionStorage,
        layer: OfflineLayer,
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): HttpAuthRepository {
        val engine = MockEngine { request ->
            requests += request
            handler(request)
        }
        return HttpAuthRepository(ApiClient(engine), storage, DEVICE, sessionEnded = { layer.clear() }, offline = layer)
    }

    private fun stored(token: String = "tok") =
        InMemorySessionStorage().apply { save(StoredSession("https://s.example", token)) }

    @Test
    fun aRestoreTheServerAnsweredKeepsThePersonForAStartWithoutAConnection() = runTest {
        val storage = stored()
        offlineRepository(storage, layer()) { json("""{"user":$USER_JSON}""") }.restore()

        val offline = offlineRepository(storage, layer()) { throw IllegalStateException("offline") }
        offline.restore()

        val status = assertIs<SessionStatus.SignedIn>(offline.status.value)
        assertEquals("https://s.example", status.session.serverUrl)
        assertEquals("a@b.cz", status.session.user.email)
        assertEquals("u1", status.session.user.id)
    }

    @Test
    fun aSignInKeepsThePersonForAStartWithoutAConnection() = runTest {
        val storage = InMemorySessionStorage()
        offlineRepository(storage, layer()) { json("""{"token":"tok","user":$USER_JSON}""") }
            .signIn("https://s.example", "a@b.cz", "secret")

        val offline = offlineRepository(storage, layer()) { throw IllegalStateException("offline") }
        offline.restore()

        assertEquals("a@b.cz", assertIs<SessionStatus.SignedIn>(offline.status.value).session.user.email)
    }

    @Test
    fun aStartWithoutAConnectionAndWithoutAKeptPersonIsUnreachable() = runTest {
        val repo = offlineRepository(stored(), layer()) { throw IllegalStateException("offline") }

        repo.restore()

        assertEquals(SessionStatus.Unreachable("https://s.example"), repo.status.value)
    }

    @Test
    fun aServerErrorAtTheStartIsSignedInWithTheKeptPerson() = runTest {
        val storage = stored()
        offlineRepository(storage, layer()) { json("""{"user":$USER_JSON}""") }.restore()

        val failing = offlineRepository(storage, layer()) { json("{}", HttpStatusCode.ServiceUnavailable) }
        failing.restore()

        assertIs<SessionStatus.SignedIn>(failing.status.value)
    }

    @Test
    fun aPersonKeptForAnotherSessionIsNotUsed() = runTest {
        offlineRepository(stored("old"), layer()) { json("""{"user":$USER_JSON}""") }.restore()

        val repo = offlineRepository(stored("new"), layer()) { throw IllegalStateException("offline") }
        repo.restore()

        assertEquals(SessionStatus.Unreachable("https://s.example"), repo.status.value)
    }

    @Test
    fun aRefusedRestoreRemovesTheKeptPerson() = runTest {
        val storage = stored()
        offlineRepository(storage, layer()) { json("""{"user":$USER_JSON}""") }.restore()
        offlineRepository(storage, layer()) { json("{}", HttpStatusCode.Unauthorized) }.restore()
        storage.save(StoredSession("https://s.example", "tok"))

        val offline = offlineRepository(storage, layer()) { throw IllegalStateException("offline") }
        offline.restore()

        assertEquals(SessionStatus.Unreachable("https://s.example"), offline.status.value)
    }

    @Test
    fun signingOutRemovesTheKeptPerson() = runTest {
        val storage = InMemorySessionStorage()
        val repo = offlineRepository(storage, layer()) { json("""{"token":"tok","user":$USER_JSON}""") }
        repo.signIn("https://s.example", "a@b.cz", "secret")
        repo.signOut()
        storage.save(StoredSession("https://s.example", "tok"))

        val offline = offlineRepository(storage, layer()) { throw IllegalStateException("offline") }
        offline.restore()

        assertEquals(SessionStatus.Unreachable("https://s.example"), offline.status.value)
    }

    @Test
    fun aStartWithoutAConnectionAnswersKeptReadsAtOnce() = runTest {
        var reachable = true
        val layer = layer()
        val repo = offlineRepository(stored(), layer) { request ->
            when {
                !reachable -> throw IllegalStateException("offline")
                request.url.encodedPath == AuthenticatedApi.SESSION_PATH -> json("""{"user":$USER_JSON}""")
                else -> json("{}")
            }
        }
        repo.restore()
        val kept = repo.api.send(HttpMethod.Get, "/api/overview")
        layer.frameArrived()
        reachable = false
        repo.restore()
        reachable = true
        val before = requests.size

        assertEquals(kept, repo.api.send(HttpMethod.Get, "/api/overview"))
        assertEquals(before, requests.size)
    }

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
    fun signOutRevokesTheStoredPushSubscriptionWithTheEndingSessionBeforeTheLogout() = runTest {
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        val subscriptions = InMemoryPushSubscriptionStorage().apply { save("sub-1") }
        var storedWhileEnding: StoredSession? = StoredSession("unset", "unset")
        val repo = repository(
            storage,
            endingSession = { ending ->
                storedWhileEnding = storage.load()
                RevokePushSubscription(HttpPushRepository(ending), subscriptions)()
            },
        ) { json("""{"revoked":true}""") }

        repo.signOut()

        assertNull(storedWhileEnding, "the device forgets the session before it ends it on the server")
        assertEquals(
            listOf(
                "https://s.example/api/push-subscriptions/sub-1/revoke",
                "https://s.example/api/auth/logout",
            ),
            requests.map { it.url.toString() },
        )
        assertTrue(requests.all { it.headers[HttpHeaders.Authorization] == "Bearer tok" })
        assertNull(subscriptions.load())
        assertEquals(SessionStatus.SignedOut, repo.status.value)
    }

    @Test
    fun signOutWithoutASessionEndsNothingOnTheServer() = runTest {
        var ended = 0
        val repo = repository(endingSession = { ended += 1 }) { error("no request expected") }

        repo.signOut()

        assertEquals(0, ended)
        assertTrue(requests.isEmpty())
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

    /** A way through the repository, how the server answers it, and whether it drops the session. */
    private class SessionPath(
        val name: String,
        val answer: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
        val drops: Boolean,
        val run: suspend (HttpAuthRepository) -> Unit,
    )

    @Test
    fun everyPathThatDropsTheSessionEndsItOnTheDeviceOnceAndNoOtherPathDoes() = runTest {
        val refused: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData =
            { json("{}", HttpStatusCode.Unauthorized) }
        val known: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData =
            { json("""{"user":$USER_JSON}""") }
        val offline: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData =
            { throw IllegalStateException("offline") }
        val paths = listOf(
            SessionPath("sign out", known, drops = true) { it.signOut() },
            SessionPath("a call refused with 401", refused, drops = true) { it.api.send(HttpMethod.Get, "/api/x") },
            SessionPath("a restore the server refuses", refused, drops = true) { it.restore() },
            SessionPath("a restore the server confirms", known, drops = false) { it.restore() },
            SessionPath("a restore offline", offline, drops = false) { it.restore() },
            SessionPath("a call that succeeds", known, drops = false) { it.api.send(HttpMethod.Get, "/api/x") },
        )
        for (path in paths) {
            val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
            val storedWhenEnded = mutableListOf<StoredSession?>()
            val repo = repository(storage, sessionEnded = { storedWhenEnded += storage.load() }, handler = path.answer)

            path.run(repo)

            assertEquals(if (path.drops) listOf(null) else emptyList(), storedWhenEnded, path.name)
            if (path.drops) assertEquals(SessionStatus.SignedOut, repo.status.value, path.name)
        }
    }

    @Test
    fun aSessionTheServerRefusesTakesTheThreadListsKeptForItWithIt() = runTest {
        val directory = newTestDirectory()
        val storage = InMemorySessionStorage().apply { save(StoredSession("https://s.example", "tok")) }
        var cache: FileMailThreadListCache? = null
        val repo = repository(storage, sessionEnded = { cache?.clear() }) { json("{}", HttpStatusCode.Unauthorized) }
        val lists = FileMailThreadListCache(directory, repo.api).also { cache = it }
        val kept = MailThreadList(emptyList(), nextCursor = null, changesCursor = "c1", windowEnd = null)
        lists.write(MailThreadQuery(), kept)
        assertEquals(kept, lists.read(MailThreadQuery()))

        repo.api.send(HttpMethod.Get, "/api/overview")

        assertTrue(listCacheDirectory(directory).isEmpty(), "nothing of the session is left in the cache directory")
        storage.save(StoredSession("https://s.example", "tok"))
        assertNull(lists.read(MailThreadQuery()))
        deleteCachePath(directory)
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
