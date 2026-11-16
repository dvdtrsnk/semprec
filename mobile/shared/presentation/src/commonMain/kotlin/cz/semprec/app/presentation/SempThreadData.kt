package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.SempChange
import cz.semprec.app.domain.SempChangeKind
import cz.semprec.app.domain.SempContextRef
import cz.semprec.app.domain.SempMessage
import cz.semprec.app.domain.SempMessageStatus
import cz.semprec.app.domain.SempRefInput
import cz.semprec.app.domain.SempRefKind
import cz.semprec.app.domain.SempRole
import cz.semprec.app.domain.SempRunStep
import cz.semprec.app.domain.SempRunStepState
import cz.semprec.app.domain.SempStatusSummary
import cz.semprec.app.domain.SempStepStatus
import cz.semprec.app.domain.SempThread
import cz.semprec.app.domain.SempThreadKind
import cz.semprec.app.domain.SempTimeline

/** A message of the person on its way to the server, or one that did not get there. */
internal data class SempLocalMessage(
    val id: String,
    val text: String,
    val attachments: List<SempAttachment>,
    val refs: List<SempRefInput>,
    val delivery: SempDelivery,
    val failure: FailureKind?,
)

/** The steps of one run as the person opened them. */
internal data class SempOpenedRun(val phase: SempStepsPhase, val steps: List<SempRunStep>)

/**
 * Everything a chat screen is made of, as the ViewModel holds it: the server's answers, the messages that are still
 * on their way, and what the person opened. [render] turns it into the state the screen shows; keeping the two apart
 * makes every change a plain copy of this value.
 */
internal data class SempThreadData(
    val phase: SempThreadPhase = SempThreadPhase.LOADING,
    val failure: FailureKind? = null,
    val type: SempThreadType = SempThreadType.CHAT,
    val thread: SempThread? = null,
    val title: String? = null,
    val subject: SempSubject? = null,
    val tickRunning: Boolean = false,
    val triggerFailed: Boolean = false,
    val newest: List<SempMessage> = emptyList(),
    val older: List<SempMessage> = emptyList(),
    val olderCursor: String? = null,
    val newestCursor: String? = null,
    val loadingOlder: Boolean = false,
    val locals: List<SempLocalMessage> = emptyList(),
    val approvals: Map<String, SempApprovalItem> = emptyMap(),
    val opened: Map<String, SempOpenedRun> = emptyMap(),
    val summary: SempStatusSummary? = null,
    val attachments: List<SempAttachment> = emptyList(),
    val closedNotices: Set<String> = emptySet(),
    val actionFailed: Boolean = false,
    val actionFailure: FailureKind? = null,
) {
    /** The messages a person sees: the newest page over the older pages already read. */
    val messages: List<SempMessage>
        get() = SempTimeline.visible((older + newest).distinctBy { it.id })

    val awaitsReply: Boolean get() = SempTimeline.awaitsReply(messages) || tickRunning

    val threadId: String? get() = thread?.id
}

internal fun SempThreadData.render(): SempThreadState {
    val visible = messages
    val lastAssistant = visible.lastOrNull { it.role == SempRole.ASSISTANT }?.id
    val tick = thread?.tick
    return SempThreadState(
        phase = phase,
        failure = failure,
        type = type,
        threadId = threadId,
        title = title ?: thread?.title,
        subject = subject,
        tick = tick?.let {
            SempTickInfo(it.name, it.projectName, it.enabled, it.canTrigger, tickRunning, triggerFailed)
        },
        entries = visible.map { it.toEntry(this, it.id == lastAssistant) } + locals.map { it.toEntry() },
        hasOlder = olderCursor != null,
        loadingOlder = loadingOlder,
        attachments = if (type == SempThreadType.CHAT) attachments else emptyList(),
        canAttach = type == SempThreadType.CHAT,
        sending = locals.any { it.delivery == SempDelivery.SENDING },
        notice = summary?.toNotice(closedNotices),
        actionFailed = actionFailed,
        actionFailure = actionFailure,
    )
}

private fun SempStatusSummary.toNotice(closed: Set<String>): SempNotice? {
    val id = bannerProblemId ?: return null
    return if (id in closed) null else SempNotice(id, bannerTitle.orEmpty(), bannerText.orEmpty())
}

private fun SempLocalMessage.toEntry() = SempEntry(
    id = id,
    role = SempEntryRole.USER,
    text = text,
    systemKey = null,
    chips = attachments.map { SempChip(it.kind, it.title, true) },
    delivery = delivery,
    deliveryFailure = failure,
    replyPhase = SempReplyPhase.DONE,
    run = null,
    changes = emptyList(),
    approvals = emptyList(),
    failure = null,
    incomplete = false,
    canRegenerate = false,
)

private fun SempMessage.toEntry(data: SempThreadData, isLastAssistant: Boolean): SempEntry = SempEntry(
    id = id,
    role = when (role) {
        SempRole.USER -> SempEntryRole.USER
        SempRole.ASSISTANT -> SempEntryRole.ASSISTANT
        SempRole.SYSTEM -> SempEntryRole.SYSTEM
    },
    text = text,
    systemKey = systemKey,
    chips = context.map { it.toChip() },
    delivery = null,
    deliveryFailure = null,
    replyPhase = when (status) {
        SempMessageStatus.QUEUED -> SempReplyPhase.THINKING
        SempMessageStatus.RUNNING -> SempReplyPhase.WORKING
        SempMessageStatus.DONE -> SempReplyPhase.DONE
        SempMessageStatus.ERROR -> SempReplyPhase.FAILED
    },
    run = toRunChip(data),
    changes = changes.map { it.toCard() },
    approvals = steps.mapNotNull { step -> step.approvalRequestId?.let { data.approvals[it] } },
    failure = error?.let { SempReplyFailure(it.code, it.message) },
    incomplete = incomplete,
    canRegenerate = role == SempRole.ASSISTANT && status == SempMessageStatus.DONE && isLastAssistant,
)

private fun SempMessage.toRunChip(data: SempThreadData): SempRunChip? {
    val runId = agentRunId
    if (runId == null || role != SempRole.ASSISTANT || steps.isEmpty()) return null
    val opened = data.opened[id]
    val waiting = steps.any { it.approval?.status == PENDING_APPROVAL }
    val failed = status == SempMessageStatus.ERROR || incomplete || steps.any { it.status == SempStepStatus.ERROR }
    return SempRunChip(
        runId = runId,
        messageId = id,
        stepCount = steps.size,
        durationMs = steps.sumOf { it.durationMs },
        state = when {
            waiting -> SempRunChipState.WAITING_APPROVAL
            failed -> SempRunChipState.FAILED
            else -> SempRunChipState.OK
        },
        expanded = opened != null,
        stepsPhase = opened?.phase ?: SempStepsPhase.NONE,
        steps = opened?.steps.orEmpty().map { it.toLine() },
    )
}

private const val PENDING_APPROVAL = "pending"

private fun SempRunStep.toLine() = SempStepLine(
    id = id,
    state = when (state) {
        SempRunStepState.RUNNING -> SempLineState.RUNNING
        SempRunStepState.OK -> SempLineState.OK
        SempRunStepState.ERROR -> SempLineState.ERROR
        SempRunStepState.WAITING_APPROVAL -> SempLineState.WAITING_APPROVAL
    },
    title = title,
    summary = summary ?: targetName,
    durationMs = durationMs,
)

private fun SempChange.toCard() = SempChangeCard(
    itemId = itemId,
    databaseId = databaseId,
    databaseKey = databaseKey,
    kind = targetKindOf(databaseKey),
    change = when (kind) {
        SempChangeKind.CREATED -> SempChangeType.CREATED
        SempChangeKind.UPDATED -> SempChangeType.UPDATED
        SempChangeKind.DELETED -> SempChangeType.DELETED
        SempChangeKind.RESTORED -> SempChangeType.RESTORED
        SempChangeKind.REVISED -> SempChangeType.REVISED
    },
    label = label,
    active = active,
)

private fun SempContextRef.toChip() = SempChip(
    kind = when (kind) {
        SempRefKind.MAIL_THREAD, SempRefKind.MAIL_ATTACHMENT -> SempTargetKind.MAIL
        SempRefKind.AGENT_RUN -> SempTargetKind.RUN
        SempRefKind.BLOCK -> SempTargetKind.NOTE
        SempRefKind.TRANSCRIPT_SEGMENT -> SempTargetKind.RECORDING
        SempRefKind.ITEM -> targetKindOf(databaseKey)
        SempRefKind.APPROVAL_REQUEST, SempRefKind.OTHER -> SempTargetKind.OTHER
    },
    label = label,
    exists = exists,
)

/** The kind of object the items of a database are, from the canonical key of that database. */
internal fun targetKindOf(databaseKey: String?): SempTargetKind = when (databaseKey) {
    "tasks" -> SempTargetKind.TASK
    "events" -> SempTargetKind.EVENT
    "projects" -> SempTargetKind.PROJECT
    "areas" -> SempTargetKind.AREA
    "people" -> SempTargetKind.PERSON
    "companies" -> SempTargetKind.COMPANY
    "files" -> SempTargetKind.FILE
    "journal" -> SempTargetKind.JOURNAL
    "healthRecords" -> SempTargetKind.HEALTH
    "inbox" -> SempTargetKind.INBOX
    "transcripts" -> SempTargetKind.RECORDING
    else -> SempTargetKind.OTHER
}

internal fun SempThreadKind.toType(): SempThreadType = when (this) {
    SempThreadKind.CHAT -> SempThreadType.CHAT
    SempThreadKind.ITEM -> SempThreadType.ITEM
    SempThreadKind.TICK -> SempThreadType.TICK
}
