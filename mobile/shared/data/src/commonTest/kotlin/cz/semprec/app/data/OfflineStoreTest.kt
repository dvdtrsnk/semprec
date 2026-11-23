package cz.semprec.app.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineStoreTest {
    private val directory = newTestDirectory()
    private val answer = KeptAnswer(200, """{"items":[]}""", "\"v1\"")

    private fun TestScope.store(maxAnswers: Int = MAX_KEPT_ANSWERS) =
        OfflineStore(directory, StandardTestDispatcher(testScheduler), maxAnswers)

    private fun answerFile(account: String, key: String) =
        "$directory/offline/$account/answers/${keptAnswerFileName(key)}"

    @Test fun `a kept answer is found again by a store created anew over the same directory`() = runTest {
        store().keep("a1", "k1", answer)
        assertEquals(answer, store().answer("a1", "k1"))
    }

    @Test fun `a key that was never kept reads as nothing`() = runTest {
        store().keep("a1", "k1", answer)
        assertNull(store().answer("a1", "k2"))
    }

    @Test fun `keeping for one account removes the answers of every other`() = runTest {
        store().keep("a1", "k1", answer)
        store().keep("a2", "k2", answer)
        assertNull(store().answer("a1", "k1"))
        assertEquals(answer, store().answer("a2", "k2"))
    }

    @Test fun `the least recently kept answer goes first past the limit`() = runTest {
        val store = store(maxAnswers = 2)
        store.keep("a1", "k1", answer)
        store.keep("a1", "k2", answer)
        store.keep("a1", "k3", answer)
        assertNull(readCacheFile(answerFile("a1", "k1")))
        val reopened = store(maxAnswers = 2)
        assertNull(reopened.answer("a1", "k1"))
        assertEquals(answer, reopened.answer("a1", "k2"))
        assertEquals(answer, reopened.answer("a1", "k3"))
    }

    @Test fun `keeping a key again moves it to the front`() = runTest {
        val store = store(maxAnswers = 2)
        store.keep("a1", "k1", answer)
        store.keep("a1", "k2", answer)
        store.keep("a1", "k1", answer)
        store.keep("a1", "k3", answer)
        val reopened = store(maxAnswers = 2)
        assertEquals(answer, reopened.answer("a1", "k1"))
        assertNull(reopened.answer("a1", "k2"))
    }

    @Test fun `an answer too long to keep leaves the one kept before`() = runTest {
        store().keep("a1", "k1", answer)
        val long = KeptAnswer(200, "x".repeat(MAX_KEPT_ANSWER_BYTES + 1), null)
        store().keep("a1", "k1", long)
        assertEquals(answer, store().answer("a1", "k1"))
    }

    @Test fun `an answer of exactly the limit is kept`() = runTest {
        val limit = KeptAnswer(200, "x".repeat(MAX_KEPT_ANSWER_BYTES), null)
        store().keep("a1", "k1", limit)
        assertEquals(limit, store().answer("a1", "k1"))
    }

    @Test fun `a long text of few characters but many bytes is not kept`() = runTest {
        // Each of these characters takes three bytes of UTF-8, so the text is over the limit with a third of the length.
        val wide = KeptAnswer(200, "€".repeat(MAX_KEPT_ANSWER_BYTES / 3 + 1), null)
        store().keep("a1", "k1", wide)
        assertNull(store().answer("a1", "k1"))
    }

    @Test fun `a file that cannot be decoded reads as nothing and is deleted`() = runTest {
        store().keep("a1", "k1", answer)
        writeCacheFile(answerFile("a1", "k1"), "not json")
        assertNull(store().answer("a1", "k1"))
        assertNull(readCacheFile(answerFile("a1", "k1")))
    }

    @Test fun `a file of another key reads as nothing and is deleted`() = runTest {
        store().keep("a1", "k1", answer)
        val other = readCacheFile(answerFile("a1", "k1"))?.replace("\"k1\"", "\"k9\"")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(other))
        assertNull(store().answer("a1", "k1"))
        assertNull(readCacheFile(answerFile("a1", "k1")))
    }

    @Test fun `a file of another version reads as nothing`() = runTest {
        store().keep("a1", "k1", answer)
        val older = readCacheFile(answerFile("a1", "k1"))?.replace("\"version\":1", "\"version\":0")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(older))
        assertNull(store().answer("a1", "k1"))
    }

    @Test fun `a file of another account reads as nothing`() = runTest {
        store().keep("a1", "k1", answer)
        val foreign = readCacheFile(answerFile("a1", "k1"))?.replace("\"account\":\"a1\"", "\"account\":\"a2\"")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(foreign))
        assertNull(store().answer("a1", "k1"))
    }

    @Test fun `an answer file the index does not name is deleted once the index is read`() = runTest {
        store().keep("a1", "k1", answer)
        writeCacheFile("$directory/offline/a1/answers/orphan.json", "{}")
        store().keep("a1", "k2", answer)
        assertNull(readCacheFile("$directory/offline/a1/answers/orphan.json"))
        assertEquals(answer, store().answer("a1", "k1"))
    }

    @Test fun `forget removes the kept answer`() = runTest {
        val store = store()
        store.keep("a1", "k1", answer)
        store.forget("a1", "k1")
        assertNull(store.answer("a1", "k1"))
        assertNull(store().answer("a1", "k1"))
    }

    @Test fun `clear removes everything and the ended account keeps nothing afterwards`() = runTest {
        val store = store()
        store.keep("a1", "k1", answer)
        store.clear()
        assertTrue(listCacheDirectory("$directory/offline").isEmpty())
        store.keep("a1", "k1", answer)
        assertNull(store.answer("a1", "k1"))
        assertTrue(listCacheDirectory("$directory/offline").isEmpty())
    }

    @Test fun `after a clear another account keeps its answers`() = runTest {
        val store = store()
        store.keep("a1", "k1", answer)
        store.clear()
        store.keep("a2", "k1", answer)
        assertEquals(answer, store.answer("a2", "k1"))
    }
}
