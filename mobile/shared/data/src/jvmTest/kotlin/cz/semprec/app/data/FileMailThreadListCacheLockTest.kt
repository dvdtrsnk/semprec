package cz.semprec.app.data

import cz.semprec.app.domain.MailThreadList
import cz.semprec.app.domain.MailThreadQuery
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Two caches over one directory, as two Apple windows have, on real threads. */
class FileMailThreadListCacheLockTest {
    private val directories = mutableListOf<String>()

    @AfterTest fun removeDirectories() = directories.forEach { deleteCachePath(it) }

    private fun directory() = newTestDirectory().also { directories += it }

    private val kept = MailThreadList(emptyList(), nextCursor = null, changesCursor = "c1", windowEnd = null)

    @Test
    fun aCacheOverTheSameDirectoryWaitsForTheOtherOnesWriteAndOneOverAnotherDoesNot() = runBlocking {
        val shared = directory()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        // The account is read inside the lock, so the first cache holds it until the test releases it.
        val first = FileMailThreadListCache(shared, {
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            "account-a"
        }, Dispatchers.IO)
        val second = FileMailThreadListCache(shared, { "account-a" }, Dispatchers.IO)
        val elsewhere = FileMailThreadListCache(directory(), { "account-a" }, Dispatchers.IO)

        val writing = async(Dispatchers.IO) { first.write(MailThreadQuery(), kept) }
        assertTrue(entered.await(5, TimeUnit.SECONDS), "the first cache is writing")
        val clearing = async(Dispatchers.IO) { second.clear() }

        assertEquals(Unit, withTimeoutOrNull(5_000) { elsewhere.clear() }, "another directory does not wait")
        assertNull(withTimeoutOrNull(300) { clearing.await() }, "the same directory waits for the write")
        release.countDown()
        withTimeout(5_000) {
            writing.await()
            clearing.await()
        }

        assertNull(second.read(MailThreadQuery()), "the clear ran after the write")
    }
}
