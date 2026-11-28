package cz.semprec.app.presentation

import cz.semprec.app.domain.InboxApproval
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxCardKind
import cz.semprec.app.domain.InboxCardStatus
import cz.semprec.app.domain.InboxContext
import cz.semprec.app.domain.InboxOrigin
import cz.semprec.app.domain.InboxReadiness
import cz.semprec.app.domain.InboxRisk
import cz.semprec.app.domain.readiness
import cz.semprec.app.domain.visibleGroups

/** Every card of the stack as the screen shows it, the top one first. */
internal fun InboxModel.cardStates(): List<InboxCardState> = cards.map { cardState(it) }

internal fun InboxModel.cardState(card: InboxCard): InboxCardState {
    val speaker = card.context as? InboxContext.Speaker
    val meeting = card.context as? InboxContext.Meeting
    return InboxCardState(
        id = card.id,
        type = card.kind.toType(),
        baseType = card.baseKind.toType(),
        phase = card.status.toPhase(),
        approvable = card.readiness(answersOf(card.id)).toApprovable(),
        origin = card.origin?.toState(),
        targets = card.targets.map { it.label },
        invalidText = card.invalid?.text,
        invalidField = card.invalid?.field,
        approval = card.approval?.toState(),
        groups = groupStates(card, card.visibleGroups()),
        quotes = speaker?.quotes.orEmpty(),
        reason = speaker?.reason ?: meeting?.reason,
        edited = card.editedKeys.isNotEmpty(),
        saving = (writing[card.id] ?: 0) > 0,
    )
}

private fun InboxOrigin.toState(): InboxOriginState = when (this) {
    is InboxOrigin.Capture -> InboxOriginState(
        kind = InboxOriginKind.CAPTURE,
        text = text,
        date = date,
        time = time,
        typeLabel = typeLabel,
        typeEmoji = typeEmoji,
        name = null,
        sourceKind = null,
        threadTitle = null,
        heartbeatName = null,
        mcpClientName = null,
        attachments = attachments.map { it.toState() },
    )
    is InboxOrigin.Transcript -> InboxOriginState(
        kind = InboxOriginKind.TRANSCRIPT,
        text = null,
        date = date,
        time = null,
        typeLabel = null,
        typeEmoji = null,
        name = name,
        sourceKind = null,
        threadTitle = null,
        heartbeatName = null,
        mcpClientName = null,
        attachments = emptyList(),
    )
    is InboxOrigin.Run -> InboxOriginState(
        kind = InboxOriginKind.RUN,
        text = null,
        date = null,
        time = null,
        typeLabel = null,
        typeEmoji = null,
        name = null,
        sourceKind = sourceKind,
        threadTitle = threadTitle,
        heartbeatName = heartbeatName,
        mcpClientName = mcpClientName,
        attachments = emptyList(),
    )
}

private fun InboxApproval.toState() = InboxApprovalState(
    risk = when (risk) {
        InboxRisk.IRREVERSIBLE -> InboxRiskLevel.IRREVERSIBLE
        InboxRisk.OUTBOUND -> InboxRiskLevel.OUTBOUND
        InboxRisk.BREAKS_LINK -> InboxRiskLevel.BREAKS_LINK
        InboxRisk.WRITE -> InboxRiskLevel.WRITE
    },
    operation = operation,
    reason = reason,
)

private fun InboxCardStatus.toPhase() = when (this) {
    InboxCardStatus.PROPOSED -> InboxCardPhase.PROPOSED
    InboxCardStatus.COMPUTING -> InboxCardPhase.COMPUTING
    InboxCardStatus.COMPUTE_FAILED -> InboxCardPhase.COMPUTE_FAILED
    InboxCardStatus.NEEDS_CLARIFICATION -> InboxCardPhase.NEEDS_CLARIFICATION
    InboxCardStatus.INVALID -> InboxCardPhase.INVALID
    InboxCardStatus.PENDING -> InboxCardPhase.PENDING
}

private fun InboxReadiness.toApprovable() = when (this) {
    InboxReadiness.READY -> InboxApprovable.READY
    InboxReadiness.MISSING_FIELDS -> InboxApprovable.MISSING_FIELDS
    InboxReadiness.COMPUTING -> InboxApprovable.COMPUTING
    InboxReadiness.COMPUTE_FAILED -> InboxApprovable.COMPUTE_FAILED
    InboxReadiness.INVALID -> InboxApprovable.INVALID
    InboxReadiness.UNSUPPORTED -> InboxApprovable.UNSUPPORTED
}

/** The kinds have the same names in the domain and on the screen; a test holds every one of them to it. */
private val TYPES = InboxCardKind.entries.associateWith { InboxCardType.valueOf(it.name) }

private fun InboxCardKind.toType(): InboxCardType = TYPES.getValue(this)
