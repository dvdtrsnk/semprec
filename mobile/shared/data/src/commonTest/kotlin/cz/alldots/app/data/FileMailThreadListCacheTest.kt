package cz.alldots.app.data

import cz.alldots.app.core.StoredSession
import cz.alldots.app.domain.MailBox
import cz.alldots.app.domain.MailNamedRef
import cz.alldots.app.domain.MailThreadKey
import cz.alldots.app.domain.MailThreadList
import cz.alldots.app.domain.MailThreadQuery
import cz.alldots.app.domain.MailThreadSummary
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FileMailThreadListCacheTest {
    private val directory = newTestDirectory()
    private var account: String? = "account-a"

    @AfterTest fun removeDirectory() = deleteCachePath(directory)

    private fun TestScope.cache() =
        FileMailThreadListCache(directory, { account }, StandardTestDispatcher(testScheduler))

    private fun thread(id: String, at: String = "2026-10-20T12:41:00.000000Z") = MailThreadSummary(
        threadId = id,
        subject = "Re: Nabídka",
        lastMessageAt = at,
        senderName = "Petr Novák",
        senderAddress = "petr@novak.cz",
        senderRelationship = "Klient",
        messageCount = 4,
        preview = null,
        hasAttachment = true,
        unread = true,
        flagged = false,
        mailboxNames = listOf("Gmail", "Práce"),
        project = MailNamedRef("pr1", "Web"),
        company = null,
        hasSempDraft = true,
    )

    private fun list(vararg ids: String, cursor: String = "c1") = MailThreadList(
        threads = ids.map { thread(it) },
        nextCursor = "n1",
        changesCursor = cursor,
        windowEnd = MailThreadKey("2026-10-20T12:41:00.000000Z", ids.lastOrNull().orEmpty()),
    )

    private fun view(index: Int) = MailThreadQuery(folderId = "folder-$index")

    private fun accountFiles(name: String = "account-a") =
        listCacheDirectory("$directory/mail-threads/$name").filter { it != "views.json" }

    @Test
    fun aKeptListReadsBackWithEveryFieldAndCursor() = runTest {
        val cache = cache()
        val kept = list("t1", "t2").copy(
            threads = listOf(thread("t1").copy(preview = "Díky", company = MailNamedRef("c1", "Novák")), thread("t2")),
        )

        cache.write(MailThreadQuery(), kept)

        assertEquals(kept, cache.read(MailThreadQuery()))
        assertNull(cache.read(MailThreadQuery(box = MailBox.FLAGGED)))
    }

    @Test
    fun theViewIgnoresTheSearchAndThePageCursor() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(projectId = "pr1"), list("t1"))

        assertEquals(list("t1"), cache.read(MailThreadQuery(projectId = "pr1", search = "faktura", cursor = "x")))
        assertNull(cache.read(MailThreadQuery(projectId = "pr1", unreadOnly = true)))
    }

    @Test
    fun aListOfMoreRowsThanTheBoundIsNotKeptAndTheListBeforeStays() = runTest {
        val cache = cache()
        val atBound = list(*Array(MAIL_LIST_CACHE_MAX_ROWS) { "t$it" })
        cache.write(MailThreadQuery(), atBound)

        cache.write(MailThreadQuery(), list(*Array(MAIL_LIST_CACHE_MAX_ROWS + 1) { "u$it" }, cursor = "c2"))

        assertEquals(atBound, cache.read(MailThreadQuery()))
    }

    @Test
    fun theLeastRecentlyUsedViewGoesBeyondTheBound() = runTest {
        val cache = cache()
        repeat(MAIL_LIST_CACHE_MAX_VIEWS) { cache.write(view(it), list("t$it")) }
        // Reading the oldest view makes it the most recently used one; the second oldest goes instead.
        assertEquals(list("t0"), cache.read(view(0)))

        cache.write(view(MAIL_LIST_CACHE_MAX_VIEWS), list("new"))

        assertEquals(list("t0"), cache.read(view(0)))
        assertNull(cache.read(view(1)))
        assertEquals(list("t2"), cache.read(view(2)))
        assertEquals(list("new"), cache.read(view(MAIL_LIST_CACHE_MAX_VIEWS)))
        assertEquals(MAIL_LIST_CACHE_MAX_VIEWS, accountFiles().size)
    }

    @Test
    fun eachAccountReadsOnlyItsOwnListsAndWritingForOneDropsTheOthers() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(), list("of-a"))

        account = "account-b"
        assertNull(cache.read(MailThreadQuery()))
        cache.write(MailThreadQuery(), list("of-b"))
        assertEquals(list("of-b"), cache.read(MailThreadQuery()))

        account = "account-a"
        assertNull(cache.read(MailThreadQuery()))
        assertEquals(listOf("account-b"), listCacheDirectory("$directory/mail-threads"))
    }

    @Test
    fun signedOutItKeepsAndFindsNothing() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(), list("t1"))

        account = null
        assertNull(cache.read(MailThreadQuery()))
        cache.write(MailThreadQuery(box = MailBox.FLAGGED), list("t2"))

        account = "account-a"
        assertNull(cache.read(MailThreadQuery(box = MailBox.FLAGGED)))
        assertEquals(list("t1"), cache.read(MailThreadQuery()))
    }

    @Test
    fun clearingOnSignOutForgetsEveryListOfEveryAccount() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(), list("t1"))
        cache.write(MailThreadQuery(box = MailBox.FLAGGED), list("t2"))

        cache.clear()

        assertNull(cache.read(MailThreadQuery()))
        assertNull(cache.read(MailThreadQuery(box = MailBox.FLAGGED)))
        assertTrue(listCacheDirectory("$directory/mail-threads").isEmpty())
    }

    @Test
    fun aFileItCannotDecodeReadsAsNothingAndIsDeleted() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(), list("t1"))
        val file = accountFiles().single()
        assertTrue(writeCacheFile("$directory/mail-threads/account-a/$file", "{\"version\":1,\"threads\":[{"))

        assertNull(cache.read(MailThreadQuery()))
        assertTrue(accountFiles().isEmpty())
        cache.write(MailThreadQuery(), list("t2"))
        assertEquals(list("t2"), cache.read(MailThreadQuery()))
    }

    @Test
    fun aFileOfAnotherViewOrAccountReadsAsNothing() = runTest {
        val cache = cache()
        cache.write(MailThreadQuery(), list("inbox"))
        val inboxFile = accountFiles().single()
        val inboxText = readCacheFile("$directory/mail-threads/account-a/$inboxFile")
        cache.write(MailThreadQuery(box = MailBox.FLAGGED), list("flagged"))
        val flaggedFile = accountFiles().single { it != inboxFile }

        assertTrue(writeCacheFile("$directory/mail-threads/account-a/$flaggedFile", inboxText.orEmpty()))
        assertNull(cache.read(MailThreadQuery(box = MailBox.FLAGGED)))

        account = "account-c"
        cache.write(MailThreadQuery(), list("of-c"))
        assertTrue(writeCacheFile("$directory/mail-threads/account-c/$inboxFile", inboxText.orEmpty()))
        assertNull(cache.read(MailThreadQuery()))
    }

    @Test
    fun theAccountIsNamedWithoutTheTokenAndPerSession() {
        val key = accountKey(StoredSession("https://s.example", "secret-token"))

        assertFalse(key.contains("secret-token"))
        assertTrue(key.all { it in '0'..'9' || it in 'a'..'f' })
        assertEquals(key, accountKey(StoredSession("https://s.example", "secret-token")))
        assertNotEquals(key, accountKey(StoredSession("https://s.example", "another-token")))
        assertNotEquals(key, accountKey(StoredSession("https://t.example", "secret-token")))
    }
}
