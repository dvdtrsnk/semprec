package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** The stack of cards, with the item types when a card asks to be clarified (they are what it can become). */
data class InboxContent(val stack: InboxStack, val types: List<InboxType>)

/** Loads the Inbox: the stack, and the types only when a card needs them. */
class LoadInbox(private val repository: InboxRepository) {
    suspend operator fun invoke(): RepositoryResult<InboxContent> = repository.stack().then { stack ->
        if (stack.cards.none { it.kind == InboxCardKind.CLARIFY }) {
            RepositoryResult.Content(InboxContent(stack, emptyList()))
        } else {
            // A card that asks for a type is useless without them, so their failure is the failure of the load.
            repository.types().map { InboxContent(stack, it) }
        }
    }
}

/** Saves what the person changed on a card: values of the proposal, or a new proposal of the card. */
class EditInboxCard(private val repository: InboxRepository) {
    /** `null` content means the change does not apply to the card, so nothing was sent. */
    suspend operator fun invoke(card: InboxCard, change: InboxChange): RepositoryResult<InboxCard?> =
        when (change) {
            InboxChange.None -> RepositoryResult.Content(null)
            is InboxChange.Edit -> repository.edit(card, change.edit)
            is InboxChange.Revise -> repository.revise(card, change.revision)
        }.map { it }
}

/** What a decision on a card did: the item it created, when there is one to show. */
data class InboxDecided(val outcome: InboxOutcome?, val removed: Boolean = true)

/**
 * Decides a card. Approving needs the card to be ready (see [readiness]): what it sends depends on the kind of card,
 * an approval of Semp, a capture that is given a type, or a proposal that is confirmed.
 */
class DecideInboxCard(private val repository: InboxDecisions) {
    suspend fun approve(card: InboxCard, answers: InboxAnswers): RepositoryResult<InboxDecided> {
        if (card.readiness(answers) != InboxReadiness.READY) return RepositoryResult.Failure(FailureKind.REJECTED)
        val typeId = answers.typeId
        return when {
            card.kind == InboxCardKind.APPROVAL ->
                repository.decideApproval(card, approve = true).map { InboxDecided(null) }
            // The capture stays in the stack: Semp now computes a proposal of the type that was chosen.
            card.kind == InboxCardKind.CLARIFY && typeId != null ->
                repository.changeType(card, typeId).map { InboxDecided(null, removed = false) }
            else -> repository.confirm(card, answers.secret.takeIf { card.kind == InboxCardKind.MCP })
                .map { InboxDecided(it) }
        }
    }

    suspend fun reject(card: InboxCard): RepositoryResult<InboxDecided> =
        if (card.kind == InboxCardKind.APPROVAL) {
            repository.decideApproval(card, approve = false)
        } else {
            repository.reject(card)
        }.map { InboxDecided(null) }
}
