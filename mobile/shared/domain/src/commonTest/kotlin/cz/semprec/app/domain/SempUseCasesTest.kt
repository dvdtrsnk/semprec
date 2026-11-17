package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private fun message(
    id: String,
    role: SempRole,
    at: String,
    replyTo: String? = null,
    attempt: Int = 1,
    replaced: Boolean = false,
    status: SempMessageStatus = SempMessageStatus.DONE,
) = SempMessage(
    id = id,
    role = role,
    text = id,
    systemKey = null,
    context = emptyList(),
    replyToMessageId = replyTo,
    attempt = attempt,
    replaced = replaced,
    agentRunId = null,
    status = status,
    createdAt = at,
    changes = emptyList(),
    steps = emptyList(),
    incomplete = false,
    error = null,
)

private class RecordingChats(var sendAnswer: RepositoryResult<SempSendReceipt>? = null) : SempRepository {
    val sent = mutableListOf<SempSendRequest>()
    val queries = mutableListOf<SempThreadsQuery>()

    override suspend fun threads(query: SempThreadsQuery): RepositoryResult<SempThreadsPage> {
        queries += query
        return RepositoryResult.Content(SempThreadsPage(emptyList(), null))
    }

    override suspend fun thread(threadId: String): RepositoryResult<SempThread> =
        RepositoryResult.Content(SempThread(threadId, SempThreadKind.CHAT, null, null, null, null))

    override suspend fun messages(threadId: String, before: String?): RepositoryResult<SempMessagesPage> =
        RepositoryResult.Content(
            SempMessagesPage(
                listOf(
                    message("a2", SempRole.ASSISTANT, "2", replyTo = "u1", attempt = 2),
                    message("a1", SempRole.ASSISTANT, "1", replyTo = "u1", attempt = 1),
                    message("u1", SempRole.USER, "0"),
                ),
                null,
            ),
        )

    override suspend fun send(request: SempSendRequest): RepositoryResult<SempSendReceipt> {
        sent += request
        return sendAnswer ?: RepositoryResult.Content(SempSendReceipt("t", "m", "r"))
    }

    override suspend fun retry(threadId: String, messageId: String) = RepositoryResult.Content(Unit)

    override suspend fun regenerate(threadId: String, messageId: String) = RepositoryResult.Content(Unit)
}

class SempUseCasesTest {

    @Test fun `the timeline shows the newest attempt of a reply in the order the messages were made`() {
        val shown = SempTimeline.visible(
            listOf(
                message("a2", SempRole.ASSISTANT, "2", replyTo = "u1", attempt = 2),
                message("a1", SempRole.ASSISTANT, "1", replyTo = "u1", attempt = 1),
                message("u1", SempRole.USER, "0"),
                message("s1", SempRole.SYSTEM, "3"),
            ),
        )

        assertEquals(listOf("u1", "a2", "s1"), shown.map { it.id })
    }

    @Test fun `the timeline hides a replaced answer but keeps replies to other messages`() {
        val shown = SempTimeline.visible(
            listOf(
                message("u1", SempRole.USER, "0"),
                message("a1", SempRole.ASSISTANT, "1", replyTo = "u1", replaced = true),
                message("u2", SempRole.USER, "2"),
                message("a2", SempRole.ASSISTANT, "3", replyTo = "u2"),
            ),
        )

        assertEquals(listOf("u1", "u2", "a2"), shown.map { it.id })
    }

    @Test fun `messages made at the same instant keep a stable order by id`() {
        val shown = SempTimeline.visible(listOf(message("b", SempRole.USER, "1"), message("a", SempRole.USER, "1")))

        assertEquals(listOf("a", "b"), shown.map { it.id })
    }

    @Test fun `a reply that is queued or running is awaited and one that is done or failed is not`() {
        fun awaits(status: SempMessageStatus) =
            SempTimeline.awaitsReply(listOf(message("a", SempRole.ASSISTANT, "1", replyTo = "u", status = status)))

        assertTrue(awaits(SempMessageStatus.QUEUED))
        assertTrue(awaits(SempMessageStatus.RUNNING))
        assertFalse(awaits(SempMessageStatus.DONE))
        assertFalse(awaits(SempMessageStatus.ERROR))
        val queuedUser = message("u", SempRole.USER, "0", status = SempMessageStatus.QUEUED)
        assertFalse(SempTimeline.awaitsReply(listOf(queuedUser)))
    }

    @Test fun `a conversation is the thread with the visible messages and the cursor of the older ones`() = runTest {
        val conversation = (LoadSempConversation(RecordingChats())("t1") as RepositoryResult.Content).value

        assertEquals("t1", conversation.thread.id)
        assertEquals(listOf("u1", "a2"), conversation.messages.map { it.id })
    }

    @Test fun `a blank thread id is invalid data`() = runTest {
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), LoadSempConversation(RecordingChats())("  "))
    }

    @Test fun `a message is trimmed before it is sent`() = runTest {
        val chats = RecordingChats()

        SendSempMessage(chats)(SempSendRequest(null, null, "  Hello  ", emptyList()))

        assertEquals("Hello", chats.sent.single().text)
    }

    @Test fun `a blank message and a message with too many objects are not sent`() = runTest {
        val chats = RecordingChats()
        val many = List(SEMP_MAX_CONTEXT + 1) { SempRefInput(SempRefKind.ITEM, "i$it", "d") }

        val blank = SendSempMessage(chats)(SempSendRequest(null, null, "   ", emptyList()))
        val crowded = SendSempMessage(chats)(SempSendRequest(null, null, "Hi", many))
        val exact = SendSempMessage(chats)(SempSendRequest(null, null, "Hi", many.take(SEMP_MAX_CONTEXT)))

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), blank)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), crowded)
        assertTrue(exact is RepositoryResult.Content)
        assertEquals(1, chats.sent.size)
    }

    @Test fun `the history trims the search and a blank search is none`() = runTest {
        val chats = RecordingChats()

        ListSempThreads(chats)(SempThreadsQuery(setOf(SempThreadKind.CHAT), search = "  faktura "))
        ListSempThreads(chats)(SempThreadsQuery(setOf(SempThreadKind.CHAT), search = "   "))

        assertEquals(listOf("faktura", null), chats.queries.map { it.search })
    }

    @Test fun `the steps of a run are read page after page and stop at the end`() = runTest {
        val runs = PagedRuns(3)

        val page = (LoadSempRunSteps(runs)("r1", "m1") as RepositoryResult.Content).value

        assertEquals(listOf("s0", "s1", "s2"), page.steps.map { it.id })
        assertEquals(listOf<String?>(null, "c1", "c2"), runs.cursors)
        assertTrue(page.truncatedHistory)
        assertEquals(null, page.nextCursor)
    }

    @Test fun `a failing page ends the reading with its failure`() = runTest {
        val runs = PagedRuns(3, failAt = 1)

        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), LoadSempRunSteps(runs)("r1", null))
        assertEquals(2, runs.cursors.size)
    }

    @Test fun `a run with endless pages is read only a bounded number of times`() = runTest {
        val runs = PagedRuns(1_000)

        val page = (LoadSempRunSteps(runs)("r1", null) as RepositoryResult.Content).value

        assertEquals(10, runs.cursors.size)
        assertEquals("c10", page.nextCursor)
    }

    @Test fun `a blank run id is invalid data`() = runTest {
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), LoadSempRun(PagedRuns(1))(" ", null))
    }

    @Test fun `only a finding of behaviour or a dismissal is sent to the server`() = runTest {
        val repository = RecordingAgent()
        val behavior = SempDriftFinding("f1", SempDriftKind.BEHAVIOR, "c", false, "allow", "forbid")
        val permission = behavior.copy(id = "f2", kind = SempDriftKind.PERMISSION)
        val edit = EditSempProjectAgent(repository)

        edit.resolveDrift("p", behavior, SempDriftChoice.ALLOW, "v1")
        val refused = edit.resolveDrift("p", permission, SempDriftChoice.FORBID, "v1")
        edit.resolveDrift("p", permission, SempDriftChoice.DISMISS, "v1")

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), refused)
        assertEquals(listOf("f1", "f2"), repository.resolved)
    }
}

private class PagedRuns(private val pages: Int, private val failAt: Int = -1) : SempRunRepository {
    val cursors = mutableListOf<String?>()

    override suspend fun run(runId: String, messageId: String?): RepositoryResult<SempRun> =
        RepositoryResult.Failure(FailureKind.NOT_FOUND)

    override suspend fun steps(runId: String, messageId: String?, after: String?): RepositoryResult<SempRunStepsPage> {
        val index = cursors.size
        cursors += after
        if (index == failAt) return RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        val step = SempRunStep("s$index", SempRunStepKind.TOOL, SempRunStepState.OK, "t", null, "t", null, null, null)
        val next = if (index + 1 < pages) "c${index + 1}" else null
        return RepositoryResult.Content(SempRunStepsPage(listOf(step), next, index == 0))
    }

    override suspend fun retry(runId: String) = RepositoryResult.Content(Unit)

    override suspend fun projectRuns(projectId: String): RepositoryResult<List<SempProjectRun>> =
        RepositoryResult.Content(emptyList())
}

private class RecordingAgent : SempProjectAgentRepository {
    val resolved = mutableListOf<String>()
    private val document = SempGuidanceDocument(SempGuidance("", "", "", ""), "v1")

    override suspend fun projectName(projectId: String) = RepositoryResult.Content<String?>(null)

    override suspend fun guidance(projectId: String) = RepositoryResult.Content(document)

    override suspend fun saveGuidance(projectId: String, guidance: SempGuidance, expectedUpdatedAt: String?) =
        RepositoryResult.Content(SempGuidanceSave.Saved(document))

    override suspend fun drift(projectId: String) = RepositoryResult.Content(SempDrift(null, emptyList()))

    override suspend fun resolveDrift(
        projectId: String,
        findingId: String,
        choice: SempDriftChoice,
        expectedGuidanceUpdatedAt: String?,
    ): RepositoryResult<SempGuidanceSave> {
        resolved += findingId
        return RepositoryResult.Content(SempGuidanceSave.Saved(document))
    }

    override suspend fun grants(projectId: String) = RepositoryResult.Content(emptyList<SempToolGrant>())

    override suspend fun setGrant(projectId: String, registrationId: String, granted: Boolean) =
        RepositoryResult.Content(Unit)

    override suspend fun tasks(projectId: String) = RepositoryResult.Content(emptyList<SempProjectTask>())

    override suspend fun setTaskEnabled(taskId: String, enabled: Boolean) = RepositoryResult.Content(Unit)

    override suspend fun runTask(taskId: String) = RepositoryResult.Content(Unit)
}
