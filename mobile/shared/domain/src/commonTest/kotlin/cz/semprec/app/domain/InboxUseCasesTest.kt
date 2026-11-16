package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private val unit = RepositoryResult.Content(Unit)

/** A repository that records its calls and answers with what the test puts in it. */
private class RecordingInbox(
    var stack: RepositoryResult<InboxStack> = RepositoryResult.Content(InboxStack(emptyList(), 0)),
    var types: RepositoryResult<List<InboxType>> = RepositoryResult.Content(emptyList()),
    var confirmed: RepositoryResult<InboxOutcome?> = RepositoryResult.Content(null),
) : InboxRepository, InboxDecisions {
    val calls = mutableListOf<String>()

    private fun <T> T.noted(call: String): T = also { calls += call }

    override suspend fun stack() = stack.noted("stack")
    override suspend fun count() = RepositoryResult.Content(0).noted("count")
    override suspend fun types() = types.noted("types")
    override suspend fun options(card: InboxCard, source: String) =
        RepositoryResult.Content(emptyList<InboxChoice>()).noted("options $source")
    override suspend fun edit(card: InboxCard, edit: InboxEdit) = RepositoryResult.Content(card).noted("edit")
    override suspend fun revise(card: InboxCard, revision: InboxRevision) =
        RepositoryResult.Content(card).noted("revise $revision")
    override suspend fun reset(card: InboxCard) = RepositoryResult.Content(card).noted("reset")
    override suspend fun recompute(card: InboxCard) = unit.noted("recompute")
    override suspend fun confirm(card: InboxCard, credential: String?) = confirmed.noted("confirm $credential")
    override suspend fun reject(card: InboxCard) = unit.noted("reject")
    override suspend fun decideApproval(card: InboxCard, approve: Boolean) = unit.noted("approval $approve")
    override suspend fun changeType(card: InboxCard, typeId: String) = unit.noted("type $typeId")
    override suspend fun reopen(cardId: String) = unit.noted("reopen")
}

private fun inboxCard(kind: InboxCardKind, status: InboxCardStatus = InboxCardStatus.PROPOSED) = InboxCard(
    id = "c1",
    kind = kind,
    baseKind = kind,
    status = status,
    version = "v1",
    origin = null,
    targets = emptyList(),
    envelope = InboxEnvelope(InboxEntityKind.DATABASE, "db", mapOf("name" to InboxValue.Text("A")), emptyMap()),
    schema = InboxSchema("x", listOf(InboxGroup("g", listOf(InboxField("name", InboxControl.TEXT, required = true))))),
)

class InboxUseCasesTest {
    @Test fun `the inbox loads its types only when a card asks to be clarified`() = runTest {
        val repository =
            RecordingInbox(stack = RepositoryResult.Content(InboxStack(listOf(inboxCard(InboxCardKind.TASK)), 1)))
        val plain = assertIs<RepositoryResult.Content<InboxContent>>(LoadInbox(repository)()).value
        assertEquals(1, plain.stack.total)
        assertEquals(listOf("stack"), repository.calls)

        repository.stack = RepositoryResult.Content(InboxStack(listOf(inboxCard(InboxCardKind.CLARIFY)), 1))
        repository.types = RepositoryResult.Content(listOf(InboxType("t1", "Task", "T", null)))
        val withTypes = assertIs<RepositoryResult.Content<InboxContent>>(LoadInbox(repository)()).value
        assertEquals(listOf("t1"), withTypes.types.map { it.id })
    }

    @Test fun `a failure of the stack or of the types is the failure of the load`() = runTest {
        val failed = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        assertEquals(failed, LoadInbox(RecordingInbox(stack = failed))())
        val clarify = RepositoryResult.Content(InboxStack(listOf(inboxCard(InboxCardKind.CLARIFY)), 1))
        assertEquals(failed, LoadInbox(RecordingInbox(stack = clarify, types = failed))())
    }

    @Test fun `an edit of a field the card has no place for sends nothing and the others are saved`() = runTest {
        val repository = RecordingInbox()
        val edit = EditInboxCard(repository)
        val card = inboxCard(InboxCardKind.TASK)

        val none = edit(card, InboxField("followupTask", InboxControl.TOGGLE), InboxInput.Flag(true))
        assertEquals(RepositoryResult.Content(null), none)
        assertEquals(emptyList(), repository.calls)

        val saved = edit(card, card.schema!!.fields.first(), InboxInput.Text("B"))
        assertEquals(RepositoryResult.Content(card), saved)
        assertEquals(listOf("edit"), repository.calls)
    }

    @Test fun `a page of a page content card is revised and not edited`() = runTest {
        val repository = RecordingInbox()
        val page = inboxCard(InboxCardKind.PAGE).copy(
            envelope = InboxEnvelope(InboxEntityKind.PAGE_CONTENT, "p1", emptyMap(), emptyMap()),
        )
        val field = InboxField("page", InboxControl.SELECT)
        EditInboxCard(repository)(page, field, InboxInput.Pick(InboxChoice("p2", "Two")))
        assertEquals(1, repository.calls.size)
        assertEquals(true, repository.calls.single().startsWith("revise"))
    }

    @Test fun `approving confirms a proposal and carries the secret of a server only`() = runTest {
        val outcome = InboxOutcome("Task", "tasks", "t1")
        val repository = RecordingInbox(confirmed = RepositoryResult.Content(outcome))
        val decide = DecideInboxCard(repository)

        val task = assertIs<RepositoryResult.Content<InboxDecided>>(
            decide.approve(inboxCard(InboxCardKind.TASK), InboxAnswers(secret = "s")),
        ).value
        assertEquals(InboxDecided(outcome), task)
        decide.approve(inboxCard(InboxCardKind.MCP), InboxAnswers(secret = "s"))
        assertEquals(listOf("confirm null", "confirm s"), repository.calls)
    }

    @Test fun `approving an approval of Semp decides it and a capture without a type is not approvable`() = runTest {
        val repository = RecordingInbox()
        val decide = DecideInboxCard(repository)
        val approval = inboxCard(InboxCardKind.APPROVAL, InboxCardStatus.PENDING)

        assertEquals(RepositoryResult.Content(InboxDecided(null)), decide.approve(approval, InboxAnswers()))
        decide.reject(approval)
        assertEquals(listOf("approval true", "approval false"), repository.calls)
    }

    @Test fun `a clarified capture gets its type and stays in the stack`() = runTest {
        val repository = RecordingInbox()
        val decide = DecideInboxCard(repository)
        val clarify = inboxCard(InboxCardKind.CLARIFY, InboxCardStatus.NEEDS_CLARIFICATION)
            .copy(schema = null, envelope = null)

        assertEquals(
            RepositoryResult.Failure(FailureKind.REJECTED),
            decide.approve(clarify, InboxAnswers()),
        )
        assertEquals(emptyList(), repository.calls)
        assertEquals(
            RepositoryResult.Content(InboxDecided(null, removed = false)),
            decide.approve(clarify, InboxAnswers(typeId = "t2")),
        )
        assertEquals(listOf("type t2"), repository.calls)
    }

    @Test fun `a card that is not ready is not approved and a proposal is rejected plainly`() = runTest {
        val repository = RecordingInbox()
        val decide = DecideInboxCard(repository)
        val computing = inboxCard(InboxCardKind.TASK, InboxCardStatus.COMPUTING)

        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), decide.approve(computing, InboxAnswers()))
        assertEquals(RepositoryResult.Content(InboxDecided(null)), decide.reject(computing))
        assertEquals(listOf("reject"), repository.calls)
    }

    @Test fun `a refused confirmation is the failure of the decision`() = runTest {
        val failed = RepositoryResult.Failure(FailureKind.REJECTED)
        val decide = DecideInboxCard(RecordingInbox(confirmed = failed))
        assertEquals(failed, decide.approve(inboxCard(InboxCardKind.TASK), InboxAnswers()))
    }
}
