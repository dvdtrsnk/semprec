package cz.alldots.app.presentation

import cz.alldots.app.domain.InboxCard
import cz.alldots.app.domain.InboxCardKind
import cz.alldots.app.domain.InboxCardStatus
import cz.alldots.app.domain.InboxChoice
import cz.alldots.app.domain.InboxContext
import cz.alldots.app.domain.InboxControl
import cz.alldots.app.domain.InboxDecisions
import cz.alldots.app.domain.InboxEdit
import cz.alldots.app.domain.InboxEntityKind
import cz.alldots.app.domain.InboxEnvelope
import cz.alldots.app.domain.InboxField
import cz.alldots.app.domain.InboxGroup
import cz.alldots.app.domain.InboxOrigin
import cz.alldots.app.domain.InboxOutcome
import cz.alldots.app.domain.InboxRepository
import cz.alldots.app.domain.InboxRevision
import cz.alldots.app.domain.InboxSchema
import cz.alldots.app.domain.InboxStack
import cz.alldots.app.domain.InboxType
import cz.alldots.app.domain.InboxValue
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.applying

/** A step of a scripted inbox that answers a write. */
internal typealias InboxWrite<T> = suspend () -> RepositoryResult<T>

/**
 * A scripted Inbox: the stack is answered by [stacks] (each call takes the next, then the last repeats), every other
 * call is recorded in [calls] and answered by the lambda that a test replaces.
 */
internal class ScriptedInbox(vararg stacks: ScriptedStep<InboxStack>) : InboxRepository, InboxDecisions {
    private val stackScript = CallScript(stacks.toList())
    val calls = mutableListOf<String>()
    val stackCalls get() = stackScript.calls
    val stackCancellations get() = stackScript.cancellations

    private var versions = 0
    var types: RepositoryResult<List<InboxType>> = RepositoryResult.Content(emptyList())
    var onOptions: suspend (InboxCard, String) -> RepositoryResult<List<InboxChoice>> =
        { _, _ -> RepositoryResult.Content(listOf(InboxChoice("p1", "Project one"), InboxChoice("p2", "Project two"))) }
    var onEdit: suspend (InboxCard, InboxEdit) -> RepositoryResult<InboxCard> =
        { card, edit -> RepositoryResult.Content(card.applying(edit).copy(version = "v${++versions}")) }
    var onRevise: suspend (InboxCard, InboxRevision) -> RepositoryResult<InboxCard> =
        { card, _ -> RepositoryResult.Content(card.copy(version = "v${++versions}")) }
    var onReset: suspend (InboxCard) -> RepositoryResult<InboxCard> =
        { card -> RepositoryResult.Content(card.copy(editedKeys = emptySet(), version = "v${++versions}")) }
    var onConfirm: suspend (InboxCard, String?) -> RepositoryResult<InboxOutcome?> =
        { _, _ -> RepositoryResult.Content(InboxOutcome("Task", "tasks", "item-1")) }
    var onUnit: suspend () -> RepositoryResult<Unit> = { RepositoryResult.Content(Unit) }

    override suspend fun stack(): RepositoryResult<InboxStack> = stackScript.next().also { calls += "stack" }

    override suspend fun count(): RepositoryResult<Int> = RepositoryResult.Content(0)

    override suspend fun types(): RepositoryResult<List<InboxType>> = types.also { calls += "types" }

    override suspend fun options(card: InboxCard, source: String): RepositoryResult<List<InboxChoice>> =
        onOptions(card, source).also { calls += "options ${card.id} $source" }

    override suspend fun edit(card: InboxCard, edit: InboxEdit): RepositoryResult<InboxCard> {
        calls += "edit ${card.id} ${card.version} ${edit.values.values.flatMap { it.keys }}"
        return onEdit(card, edit)
    }

    override suspend fun revise(card: InboxCard, revision: InboxRevision): RepositoryResult<InboxCard> {
        calls += "revise ${card.id} $revision"
        return onRevise(card, revision)
    }

    override suspend fun reset(card: InboxCard): RepositoryResult<InboxCard> {
        calls += "reset ${card.id}"
        return onReset(card)
    }

    override suspend fun recompute(card: InboxCard): RepositoryResult<Unit> {
        calls += "recompute ${card.id}"
        return onUnit()
    }

    override suspend fun confirm(card: InboxCard, credential: String?): RepositoryResult<InboxOutcome?> {
        calls += "confirm ${card.id} $credential"
        return onConfirm(card, credential)
    }

    override suspend fun reject(card: InboxCard): RepositoryResult<Unit> {
        calls += "reject ${card.id}"
        return onUnit()
    }

    override suspend fun decideApproval(card: InboxCard, approve: Boolean): RepositoryResult<Unit> {
        calls += "approval ${card.id} $approve"
        return onUnit()
    }

    override suspend fun changeType(card: InboxCard, typeId: String): RepositoryResult<Unit> {
        calls += "type ${card.id} $typeId"
        return onUnit()
    }

    override suspend fun reopen(cardId: String): RepositoryResult<Unit> {
        calls += "reopen $cardId"
        return onUnit()
    }
}

private val inboxTaskSchema = InboxSchema(
    "task",
    listOf(
        InboxGroup(
            "main",
            listOf(
                InboxField("name", InboxControl.TEXT, label = "Name", required = true),
                InboxField("date", InboxControl.DATETIME, label = "Date"),
                InboxField("allDay", InboxControl.TOGGLE, label = "All day"),
                InboxField("project", InboxControl.SELECT, label = "Project", optionsSource = "project"),
            ),
        ),
    ),
)

/** A proposed task card, its name and its project given. */
internal fun inboxTaskCard(id: String, name: String = "Send the invoice", version: String = "v0") = InboxCard(
    id = id,
    kind = InboxCardKind.TASK,
    baseKind = InboxCardKind.TASK,
    status = InboxCardStatus.PROPOSED,
    version = version,
    origin = InboxOrigin.Capture("item-$id", "Send the invoice tomorrow", "2026-10-16", "08:12", "Task", "T"),
    targets = emptyList(),
    envelope = InboxEnvelope(
        entityKind = InboxEntityKind.DATABASE,
        target = "db-tasks",
        properties = mapOf("name" to InboxValue.Text(name), "date" to InboxValue.Text("2026-10-17")),
        relations = mapOf("project" to listOf("p1")),
    ),
    schema = inboxTaskSchema,
)

internal fun inboxStack(vararg cards: InboxCard) = InboxStack(cards.toList(), cards.size)

internal fun inboxContent(vararg cards: InboxCard): ScriptedStep<InboxStack> =
    { RepositoryResult.Content(inboxStack(*cards)) }

internal fun inboxSpeakerCard(id: String) = InboxCard(
    id = id,
    kind = InboxCardKind.SPEAKER,
    baseKind = InboxCardKind.SPEAKER,
    status = InboxCardStatus.NEEDS_CLARIFICATION,
    version = "v0",
    origin = InboxOrigin.Transcript("Call", "2026-10-16"),
    targets = emptyList(),
    envelope = null,
    schema = null,
    context = InboxContext.Speaker(
        "S3",
        3,
        listOf("Hello there"),
        "Talks about design",
        listOf(
            cz.alldots.app.domain.InboxCandidate("pe1", "Jana"),
            cz.alldots.app.domain.InboxCandidate("pe2", "Petr"),
        ),
    ),
)

internal fun inboxClarifyCard(id: String) = InboxCard(
    id = id,
    kind = InboxCardKind.CLARIFY,
    baseKind = InboxCardKind.CLARIFY,
    status = InboxCardStatus.NEEDS_CLARIFICATION,
    version = "v0",
    origin = InboxOrigin.Capture("item-$id", "Martin 777 123 456", "2026-10-16", "07:48", null, null),
    targets = emptyList(),
    envelope = null,
    schema = null,
)

internal fun inboxFactory(repository: ScriptedInbox, attachments: FakeAttachmentFiles = FakeAttachmentFiles()) =
    InboxViewModelFactory(repository, repository, attachments)
