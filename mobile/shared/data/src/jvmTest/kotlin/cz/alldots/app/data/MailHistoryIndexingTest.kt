package cz.alldots.app.data

import cz.alldots.app.domain.IndexMailHistory
import cz.alldots.app.domain.MailHistoryIndexEnd
import cz.alldots.app.domain.MailHistoryLogin
import cz.alldots.app.domain.MailHistoryProgress
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.io.encoding.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.minutes
import kotlin.time.TestTimeSource

private const val MAILBOX = "mb1"
private const val TOKEN = "11111111-2222-4333-8444-555555555555"
private const val PATH = "/api/mail/mailboxes/$MAILBOX/history-index"

/** A folder of the fake IMAP server: its UIDVALIDITY and each message's FETCH response by UID. */
private class ImapFolder(val uidvalidity: Long, val messages: Map<Long, ByteArray>)

private fun folderOf(uids: Iterable<Long>, uidvalidity: Long = 7, text: (Long) -> ByteArray = ::plainText) =
    ImapFolder(
        uidvalidity,
        uids.withIndex().associate { (index, uid) -> uid to fetchResponse(index + 1, uid, text(uid)) },
    )

private fun plainText(uid: Long) = "Text $uid".encodeToByteArray()

/** What the Alldots server holds of one leased folder. */
private class LeasedFolder(val folderId: String, val path: String, val uidvalidity: Long, var cursor: Long?)

/** One upload as the server received it. */
private class Upload(val body: JsonObject) {
    val rangeHigh = body.getValue("rangeHigh").jsonPrimitive.long
    val rangeLow = body.getValue("rangeLow").jsonPrimitive.long
    val uids = body.getValue("uids").jsonArray.map { it.jsonPrimitive.long }
    val folderId = body.getValue("folderId").jsonPrimitive.content
    val fetches = body.getValue("messages").jsonArray.map { it.jsonObject }.associate {
        it.getValue("uid").jsonPrimitive.long to Base64.decode(it.getValue("fetch").jsonPrimitive.content)
    }
}

/**
 * The commands of a read-only history client against [folders] by path: a sign-in refused for [refusedPassword], and
 * a `UID FETCH` that never answers when [fetchStalls].
 */
private class FakeMailbox(
    private val folders: Map<String, ImapFolder>,
    private val refusedPassword: String?,
    private val fetchStalls: Boolean,
) {
    private var selected: ImapFolder? = null

    fun ImapReply.answer(command: ImapCommand) {
        respond(command.text)?.let { line("${command.tag} $it") }
    }

    /** Writes the untagged responses of [text] and answers the tagged status; `null` never answers. */
    private fun ImapReply.respond(text: String): String? = when {
        text == "CAPABILITY" -> "OK".also { line("* CAPABILITY IMAP4rev1") }
        text.startsWith("LOGIN") -> if (text.endsWith("\"$refusedPassword\"")) "NO [AUTHENTICATIONFAILED]" else "OK"
        text.startsWith("EXAMINE ") -> if (examine(text)) "OK [READ-ONLY]" else "NO no such folder"
        text.startsWith("UID SEARCH UID ") -> "OK".also { search(text) }
        text.startsWith("UID FETCH ") -> fetch(text)
        text == "LOGOUT" -> "OK".also { line("* BYE") }
        else -> "BAD unknown"
    }

    private fun ImapReply.examine(text: String): Boolean {
        val folder = folders[text.removePrefix("EXAMINE ").trim('"')]
        selected = folder
        folder?.let { line("* OK [UIDVALIDITY ${it.uidvalidity}] valid") }
        return folder != null
    }

    private fun ImapReply.search(text: String) {
        val (low, high) = text.removePrefix("UID SEARCH UID ").split(':').map { it.toLong() }
        val found = selected?.messages?.keys?.filter { it in low..high }.orEmpty()
        line("* SEARCH ${found.joinToString(" ")}".trimEnd())
    }

    private fun ImapReply.fetch(text: String): String? {
        if (fetchStalls) return null
        val uids = text.removePrefix("UID FETCH ").substringBefore(' ').split(',').map { it.toLong() }
        uids.forEach { uid -> selected?.messages?.get(uid)?.let { bytes(it) } }
        return "OK"
    }
}

class MailHistoryIndexingTest {
    private val imapServers = mutableListOf<FakeImapServer>()

    @AfterTest fun closeServers() = imapServers.forEach { it.close() }

    /** An IMAP server holding [folders] by path, signing in anyone but [refusedPassword]. */
    private fun imap(folders: Map<String, ImapFolder>, refusedPassword: String? = null, fetchStalls: Boolean = false) =
        with(FakeMailbox(folders, refusedPassword, fetchStalls)) { FakeImapServer { answer(it) } }
            .also { imapServers += it }

    /**
     * A Alldots server leasing [folders] to [TOKEN] that takes every slice continuing a folder's cursor, unless
     * [refuse] answers the upload otherwise; [onUpload] runs first for each upload.
     */
    private inner class HistoryServer(
        val folders: MutableList<LeasedFolder>,
        val refuse: (Upload) -> Pair<HttpStatusCode, String>? = { null },
        val onUpload: (Upload) -> Unit = {},
        /** Folders the second claim leases in addition. */
        val laterFolders: List<LeasedFolder> = emptyList(),
    ) {
        val claims = CopyOnWriteArrayList<JsonObject>()
        val uploads = CopyOnWriteArrayList<Upload>()
        val releases = CopyOnWriteArrayList<JsonObject>()
        val api = MailTestServer(::answer)

        private fun answer(request: HttpRequestData): Pair<HttpStatusCode, String> {
            val body = Json.parseToJsonElement(api.bodies.last()).jsonObject
            return when (request.url.encodedPath) {
                "$PATH/claim" -> {
                    claims += body
                    if (claims.size == 2) folders += laterFolders
                    ok(claim())
                }
                "$PATH/release" -> {
                    releases += body
                    ok("""{"released":${folders.size}}""")
                }
                PATH -> upload(Upload(body))
                else -> HttpStatusCode.NotFound to "{}"
            }
        }

        private fun claim(): String {
            val leased = folders.filter { it.cursor != null }.joinToString(",") {
                """{"folderId":"${it.folderId}","path":"${it.path}","uidvalidity":${it.uidvalidity},""" +
                    """"backfillBelowUid":${it.cursor}}"""
            }
            return """{"leaseToken":"$TOKEN","leaseExpiresAt":"2026-11-22T10:10:00.000Z","folders":[$leased],""" +
                """"pendingFullBackfill":false}"""
        }

        private fun upload(upload: Upload): Pair<HttpStatusCode, String> {
            uploads += upload
            onUpload(upload)
            val folder = folders.single { it.folderId == upload.folderId }
            return refuse(upload) ?: if (folder.cursor != upload.rangeHigh) {
                refusal("mail_history_range_stale", """{"backfillBelowUid":${folder.cursor}}""")
            } else {
                folder.cursor = upload.rangeLow.takeIf { it > 1 }
                ok(
                    """{"accepted":${upload.uids.size},"backfillBelowUid":${folder.cursor},""" +
                        """"leaseExpiresAt":"2026-11-22T10:10:00.000Z"}"""
                )
            }
        }
    }

    private fun refusal(code: String, details: String = "{}") =
        HttpStatusCode.Conflict to """{"error":{"code":"$code","details":$details}}"""

    private suspend fun HistoryServer.index(
        imap: FakeImapServer,
        password: String = "secret",
        time: TestTimeSource = TestTimeSource(),
        progress: MutableList<MailHistoryProgress> = mutableListOf(),
    ): MailHistoryIndexEnd {
        val source = ImapMailHistorySource(imap.transport, ImapTimeouts())
        val index = IndexMailHistory(HttpMailHistoryRepository(api.api()), source, time)
        return withTimeout(60_000) {
            index(MAILBOX, MailHistoryLogin("imap.example.com", "me@example.com", password)) { progress += it }
        }
    }

    private fun FakeImapServer.texts() = commands.map { it.text }

    @Test
    fun aFolderIsUploadedNewestFirstInSlicesWithEveryResponseByteForByte() = runBlocking(Dispatchers.Default) {
        val uids = (1L..500L).filter { it % 10 != 0L }
        val inbox = folderOf(uids)
        val imap = imap(mapOf("INBOX" to inbox))
        val server = HistoryServer(mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 501)))
        val progress = mutableListOf<MailHistoryProgress>()

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap, progress = progress))

        val descending = uids.sortedDescending()
        assertEquals(
            listOf(
                Triple(501L, descending[199], 200),
                Triple(descending[199], descending[399], 200),
                Triple(descending[399], 1L, 50),
            ),
            server.uploads.map { Triple(it.rangeHigh, it.rangeLow, it.uids.size) },
        )
        assertEquals(descending, server.uploads.flatMap { it.uids })
        server.uploads.forEach { upload ->
            assertEquals(upload.uids.toSet(), upload.fetches.keys)
            upload.fetches.forEach { (uid, bytes) -> assertContentEquals(inbox.messages.getValue(uid), bytes) }
        }
        assertEquals(
            listOf("EXAMINE \"INBOX\"", "UID SEARCH UID 1:500"),
            imap.texts().filter {
                !it.startsWith("UID FETCH")
            }.drop(2).take(2)
        )
        assertEquals(3, imap.texts().count { it.startsWith("UID FETCH ") && it.endsWith(MAIL_HISTORY_FETCH_ITEMS) })
        assertEquals(MailHistoryProgress(1, 1, 450), progress.last())
        assertEquals(listOf(TOKEN), server.releases.map { it.getValue("leaseToken").jsonPrimitive.content })
        assertEquals("LOGOUT", imap.texts().last())
        assertTrue(imap.awaitClientClosedAll())
    }

    @Test
    fun aFetchTooLargeForOneUploadIsSplitIntoContiguousSlices() = runBlocking(Dispatchers.Default) {
        val big = ByteArray(60 * 1024) { 'x'.code.toByte() }
        val imap = imap(mapOf("INBOX" to folderOf(1L..120L) { big }))
        val server = HistoryServer(mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 121)))

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap))

        assertTrue(server.uploads.size >= 2)
        assertTrue(server.api.bodies.all { it.length < 8 * 1024 * 1024 })
        assertEquals(121L, server.uploads.first().rangeHigh)
        assertEquals(1L, server.uploads.last().rangeLow)
        server.uploads.zipWithNext().forEach { (newer, older) -> assertEquals(newer.rangeLow, older.rangeHigh) }
        assertEquals((120L downTo 1L).toList(), server.uploads.flatMap { it.uids })
    }

    @Test
    fun aMessageTooLargeToUploadLeavesTheRestOfItsFolderToTheServer() = runBlocking(Dispatchers.Default) {
        // UID 6 is larger than the server takes of one FETCH response.
        val text = { uid: Long -> ByteArray(if (uid == 6L) 70 * 1024 else 10) { 'y'.code.toByte() } }
        val imap = imap(
            mapOf(
                "INBOX" to folderOf(1L..10L, text = text),
                "Archive" to folderOf(1L..3L),
            ),
        )
        val server = HistoryServer(
            mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 11), LeasedFolder("f-archive", "Archive", 7, 4)),
        )

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap))

        assertEquals(
            listOf(Triple("f-inbox", 11L, 7L), Triple("f-archive", 4L, 1L)),
            server.uploads.map { Triple(it.folderId, it.rangeHigh, it.rangeLow) },
        )
        assertEquals(listOf(10L, 9L, 8L, 7L), server.uploads.first().uids)
        assertEquals(7L, server.folders.first().cursor)
    }

    @Test
    fun aCursorTheServerReportsElsewhereIsTakenOver() = runBlocking(Dispatchers.Default) {
        val imap = imap(mapOf("INBOX" to folderOf(1L..300L)))
        val inbox = LeasedFolder("f-inbox", "INBOX", 7, 301)
        // The server's own backfill wrote 150 to 300 meanwhile.
        val server = HistoryServer(mutableListOf(inbox), onUpload = { if (it.rangeHigh == 301L) inbox.cursor = 150 })

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap))

        assertEquals(listOf(301L, 150L), server.uploads.map { it.rangeHigh })
        assertEquals((149L downTo 1L).toList(), server.uploads.last().uids)
        assertTrue("UID SEARCH UID 1:149" in imap.texts())
        assertEquals(null, inbox.cursor)
    }

    @Test
    fun aFolderWhoseUidValidityIsNotTheLeasedOneIsSkipped() = runBlocking(Dispatchers.Default) {
        val imap = imap(mapOf("Archive" to folderOf(1L..5L, uidvalidity = 8), "INBOX" to folderOf(1L..5L)))
        val server = HistoryServer(
            mutableListOf(LeasedFolder("f-archive", "Archive", 7, 6), LeasedFolder("f-inbox", "INBOX", 7, 6)),
        )
        val progress = mutableListOf<MailHistoryProgress>()

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap, progress = progress))

        assertEquals(listOf("f-inbox"), server.uploads.map { it.folderId })
        assertEquals(1, imap.texts().count { it.startsWith("UID SEARCH") })
        assertEquals(MailHistoryProgress(2, 2, 5), progress.last())
    }

    @Test
    fun aFolderWhoseUidValidityChangedOnTheServerIsLeftAndTheNextOneIndexed() = runBlocking(Dispatchers.Default) {
        val imap = imap(mapOf("Archive" to folderOf(1L..5L), "INBOX" to folderOf(1L..5L)))
        val server = HistoryServer(
            mutableListOf(LeasedFolder("f-archive", "Archive", 7, 6), LeasedFolder("f-inbox", "INBOX", 7, 6)),
            refuse = {
                if (it.folderId == "f-archive") refusal("mail_history_uidvalidity_changed") else null
            },
        )

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap))

        assertEquals(listOf("f-archive", "f-inbox"), server.uploads.map { it.folderId })
        assertEquals(null, server.folders.last().cursor)
    }

    @Test
    fun theLeaseIsRenewedByClaimingAgainWithItsTokenWhichAlsoLeasesNewFolders() = runBlocking(Dispatchers.Default) {
        val time = TestTimeSource()
        val imap = imap(mapOf("INBOX" to folderOf(1L..450L), "Sent" to folderOf(1L..2L)))
        val server = HistoryServer(
            mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 451)),
            onUpload = { time += 5.minutes },
            laterFolders = listOf(LeasedFolder("f-sent", "Sent", 7, 3)),
        )

        assertEquals(MailHistoryIndexEnd.COMPLETE, server.index(imap, time = time))

        assertEquals(JsonObject(emptyMap()), server.claims.first())
        assertTrue(server.claims.size >= 3)
        assertTrue(server.claims.drop(1).all { it.getValue("leaseToken").jsonPrimitive.content == TOKEN })
        assertEquals(
            listOf("f-inbox", "f-sent"),
            server.uploads.map {
                it.folderId
            }.distinct()
        )
    }

    @Test
    fun aRunTheServerStopsEndsAtOnceAndStillReleasesItsLease() = runBlocking(Dispatchers.Default) {
        val refusals = listOf(
            refusal("mail_history_lease_expired") to MailHistoryIndexEnd.LEASE_LOST,
            refusal("mail_history_unavailable", """{"reason":"reauthorizationRequired"}""") to
                MailHistoryIndexEnd.UNAVAILABLE,
            (HttpStatusCode.TooManyRequests to """{"error":{"code":"rate_limited"}}""") to
                MailHistoryIndexEnd.SERVER_FAILED,
        )
        for ((answer, end) in refusals) {
            val imap = imap(mapOf("INBOX" to folderOf(1L..450L)))
            val server = HistoryServer(mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 451)), refuse = { answer })

            assertEquals(end, server.index(imap))

            assertEquals(1, server.uploads.size, end.name)
            assertEquals(1, server.releases.size, end.name)
            assertTrue(imap.awaitClientClosedAll(), end.name)
        }
    }

    @Test
    fun aRefusedSignInEndsTheRunAndStillReleasesTheLease() = runBlocking(Dispatchers.Default) {
        val imap = imap(mapOf("INBOX" to folderOf(1L..5L)), refusedPassword = "wrong")
        val server = HistoryServer(mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 6)))

        assertEquals(MailHistoryIndexEnd.IMAP_FAILED, server.index(imap, password = "wrong"))

        assertTrue(server.uploads.isEmpty())
        assertEquals(1, server.releases.size)
        assertTrue(imap.awaitClientClosedAll())
    }

    @Test
    fun aCancelledRunClosesTheConnectionAndReleasesTheLease() = runBlocking(Dispatchers.Default) {
        val imap = imap(mapOf("INBOX" to folderOf(1L..5L)), fetchStalls = true)
        val server = HistoryServer(mutableListOf(LeasedFolder("f-inbox", "INBOX", 7, 6)))
        val run = launch { server.index(imap) }
        withTimeout(10_000) { while (imap.texts().none { it.startsWith("UID FETCH") }) delay(10) }

        run.cancel()
        run.join()

        assertEquals(1, server.releases.size)
        assertTrue(server.uploads.isEmpty())
        assertTrue(imap.awaitClientClosedAll())
    }
}
