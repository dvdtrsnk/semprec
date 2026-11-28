package cz.alldots.app.data

import cz.alldots.app.domain.SessionUser
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
        store().answers.keep("a1", "k1", answer)
        assertEquals(answer, store().answers.answer("a1", "k1"))
    }

    @Test fun `a key that was never kept reads as nothing`() = runTest {
        store().answers.keep("a1", "k1", answer)
        assertNull(store().answers.answer("a1", "k2"))
    }

    @Test fun `keeping for one account removes the answers of every other`() = runTest {
        store().answers.keep("a1", "k1", answer)
        store().answers.keep("a2", "k2", answer)
        assertNull(store().answers.answer("a1", "k1"))
        assertEquals(answer, store().answers.answer("a2", "k2"))
    }

    @Test fun `the least recently kept answer goes first past the limit`() = runTest {
        val store = store(maxAnswers = 2)
        store.answers.keep("a1", "k1", answer)
        store.answers.keep("a1", "k2", answer)
        store.answers.keep("a1", "k3", answer)
        assertNull(readCacheFile(answerFile("a1", "k1")))
        val reopened = store(maxAnswers = 2)
        assertNull(reopened.answers.answer("a1", "k1"))
        assertEquals(answer, reopened.answers.answer("a1", "k2"))
        assertEquals(answer, reopened.answers.answer("a1", "k3"))
    }

    @Test fun `keeping a key again moves it to the front`() = runTest {
        val store = store(maxAnswers = 2)
        store.answers.keep("a1", "k1", answer)
        store.answers.keep("a1", "k2", answer)
        store.answers.keep("a1", "k1", answer)
        store.answers.keep("a1", "k3", answer)
        val reopened = store(maxAnswers = 2)
        assertEquals(answer, reopened.answers.answer("a1", "k1"))
        assertNull(reopened.answers.answer("a1", "k2"))
    }

    @Test fun `an answer too long to keep leaves the one kept before`() = runTest {
        store().answers.keep("a1", "k1", answer)
        val long = KeptAnswer(200, "x".repeat(MAX_KEPT_ANSWER_BYTES + 1), null)
        store().answers.keep("a1", "k1", long)
        assertEquals(answer, store().answers.answer("a1", "k1"))
    }

    @Test fun `an answer of exactly the limit is kept`() = runTest {
        val limit = KeptAnswer(200, "x".repeat(MAX_KEPT_ANSWER_BYTES), null)
        store().answers.keep("a1", "k1", limit)
        assertEquals(limit, store().answers.answer("a1", "k1"))
    }

    @Test fun `a long text of few characters but many bytes is not kept`() = runTest {
        // Each of these characters takes three bytes of UTF-8, so the text is over the limit with a third of the length.
        val wide = KeptAnswer(200, "€".repeat(MAX_KEPT_ANSWER_BYTES / 3 + 1), null)
        store().answers.keep("a1", "k1", wide)
        assertNull(store().answers.answer("a1", "k1"))
    }

    @Test fun `a file that cannot be decoded reads as nothing and is deleted`() = runTest {
        store().answers.keep("a1", "k1", answer)
        writeCacheFile(answerFile("a1", "k1"), "not json")
        assertNull(store().answers.answer("a1", "k1"))
        assertNull(readCacheFile(answerFile("a1", "k1")))
    }

    @Test fun `a file of another key reads as nothing and is deleted`() = runTest {
        store().answers.keep("a1", "k1", answer)
        val other = readCacheFile(answerFile("a1", "k1"))?.replace("\"k1\"", "\"k9\"")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(other))
        assertNull(store().answers.answer("a1", "k1"))
        assertNull(readCacheFile(answerFile("a1", "k1")))
    }

    @Test fun `a file of another version reads as nothing`() = runTest {
        store().answers.keep("a1", "k1", answer)
        val older = readCacheFile(answerFile("a1", "k1"))?.replace("\"version\":1", "\"version\":0")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(older))
        assertNull(store().answers.answer("a1", "k1"))
    }

    @Test fun `a file of another account reads as nothing`() = runTest {
        store().answers.keep("a1", "k1", answer)
        val foreign = readCacheFile(answerFile("a1", "k1"))?.replace("\"account\":\"a1\"", "\"account\":\"a2\"")
        writeCacheFile(answerFile("a1", "k1"), checkNotNull(foreign))
        assertNull(store().answers.answer("a1", "k1"))
    }

    @Test fun `an answer file the index does not name is deleted once the index is read`() = runTest {
        store().answers.keep("a1", "k1", answer)
        writeCacheFile("$directory/offline/a1/answers/orphan.json", "{}")
        store().answers.keep("a1", "k2", answer)
        assertNull(readCacheFile("$directory/offline/a1/answers/orphan.json"))
        assertEquals(answer, store().answers.answer("a1", "k1"))
    }

    @Test fun `forget removes the kept answer`() = runTest {
        val store = store()
        store.answers.keep("a1", "k1", answer)
        store.answers.forget("a1", "k1")
        assertNull(store.answers.answer("a1", "k1"))
        assertNull(store().answers.answer("a1", "k1"))
    }

    @Test fun `clear removes everything and the ended account keeps nothing afterwards`() = runTest {
        val store = store()
        store.answers.keep("a1", "k1", answer)
        store.clear()
        assertTrue(listCacheDirectory("$directory/offline").isEmpty())
        store.answers.keep("a1", "k1", answer)
        assertNull(store.answers.answer("a1", "k1"))
        assertTrue(listCacheDirectory("$directory/offline").isEmpty())
    }

    @Test fun `after a clear another account keeps its answers`() = runTest {
        val store = store()
        store.answers.keep("a1", "k1", answer)
        store.clear()
        store.answers.keep("a2", "k1", answer)
        assertEquals(answer, store.answers.answer("a2", "k1"))
    }
    private val person = SessionUser("u1", "a@b.cz", "cs", "member", "Alena")

    @Test fun `a kept person is found again by a store created anew`() = runTest {
        store().people.keep("a1", person)
        assertEquals(person, store().people.person("a1"))
        assertNull(store().people.person("a2"))
    }

    @Test fun `keeping a person removes the answers of every other account`() = runTest {
        store().answers.keep("a1", "k1", answer)
        store().people.keep("a2", person)
        assertNull(store().answers.answer("a1", "k1"))
    }

    @Test fun `a kept person of another account reads as nothing and is deleted`() = runTest {
        store().people.keep("a1", person)
        val path = "$directory/offline/a1/session.json"
        writeCacheFile(path, checkNotNull(readCacheFile(path)).replace("\"account\":\"a1\"", "\"account\":\"a9\""))
        assertNull(store().people.person("a1"))
        assertNull(readCacheFile(path))
    }

    @Test fun `a kept person that cannot be decoded reads as nothing`() = runTest {
        store().people.keep("a1", person)
        writeCacheFile("$directory/offline/a1/session.json", "[]")
        assertNull(store().people.person("a1"))
    }

    @Test fun `clear removes the kept person`() = runTest {
        val store = store()
        store.people.keep("a1", person)
        store.clear()
        assertNull(store().people.person("a1"))
    }
}
