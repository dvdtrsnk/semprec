package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.InboxApproval
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxChoice
import cz.semprec.app.domain.InboxDecisions
import cz.semprec.app.domain.InboxEdit
import cz.semprec.app.domain.InboxOrigin
import cz.semprec.app.domain.InboxOutcome
import cz.semprec.app.domain.InboxRepository
import cz.semprec.app.domain.InboxRevision
import cz.semprec.app.domain.InboxStack
import cz.semprec.app.domain.InboxType
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonObject

/**
 * The Inbox over the server: the stack of `GET /api/inbox/cards`, the writes of `/api/proposals/:id/...`, the
 * decisions of Semp's approvals (`/api/approval-requests/:id`) and the type of a capture (`/api/inbox/items/:id/type`).
 * The schema of the databases, which tells a select from a relation, is the one the collections read.
 */
class HttpInboxRepository internal constructor(
    private val items: ItemsApi,
    private val schemas: CollectionReads,
) : InboxRepository, InboxDecisions {
    constructor(api: AuthenticatedApi, schemas: CollectionReads) : this(ItemsApi(api), schemas)

    override suspend fun stack(): RepositoryResult<InboxStack> =
        items.send(HttpMethod.Get, "/api/inbox/cards").decode<InboxCardsDto>().then { list ->
            // Without the schema a card is still decided; only its select options are missing.
            val schema = (schemas.schema() as? RepositoryResult.Content)?.value
            RepositoryResult.Content(InboxStack(list.cards.map { it.toCard(schema) }, list.total))
        }

    override suspend fun count(): RepositoryResult<Int> =
        items.send(HttpMethod.Get, "/api/inbox/cards/count").decode<InboxCountDto>().map { it.total }

    override suspend fun types(): RepositoryResult<List<InboxType>> =
        items.send(HttpMethod.Get, "/api/inbox-types").decode<InboxTypesDto>().map { list ->
            list.types.map { InboxType(it.id, it.label, it.emoji, it.targetLabel) }
        }

    override suspend fun options(card: InboxCard, source: String): RepositoryResult<List<InboxChoice>> =
        items.send(HttpMethod.Get, "/api/proposals/${card.id}/options", listOf("field" to source))
            .decode<InboxOptionsDto>().map { answer -> answer.options.map { it.toChoice() } }

    override suspend fun edit(card: InboxCard, edit: InboxEdit): RepositoryResult<InboxCard> =
        items.send(HttpMethod.Patch, "/api/proposals/${card.id}/values", body = InboxWire.edit(edit, card.version))
            .decode<InboxItemDto>().map { card.after(it) }

    override suspend fun revise(card: InboxCard, revision: InboxRevision): RepositoryResult<InboxCard> =
        items.send(HttpMethod.Post, "/api/proposals/${card.id}/revise", body = InboxWire.revision(card, revision))
            .decode<InboxItemDto>().map { card.after(it) }

    override suspend fun reset(card: InboxCard): RepositoryResult<InboxCard> =
        post(card.id, "reset-overrides", InboxWire.version(card.version)).decode<InboxItemDto>()
            .map { card.after(it).copy(editedKeys = emptySet(), userValues = emptyMap()) }

    override suspend fun recompute(card: InboxCard): RepositoryResult<Unit> =
        post(card.id, "recompute", InboxWire.version(card.version)).ignoreBody()

    override suspend fun confirm(card: InboxCard, credential: String?): RepositoryResult<InboxOutcome?> =
        post(card.id, "confirm", InboxWire.confirm(card.version, credential)).decode<InboxItemDto>()
            .map { it.outcome() }

    override suspend fun reject(card: InboxCard): RepositoryResult<Unit> =
        post(card.id, "reject", InboxWire.version(card.version)).ignoreBody()

    override suspend fun decideApproval(card: InboxCard, approve: Boolean): RepositoryResult<Unit> =
        items.send(HttpMethod.Patch, "/api/approval-requests/${card.id}", body = InboxWire.decision(approve))
            .ignoreBody()

    override suspend fun changeType(card: InboxCard, typeId: String): RepositoryResult<Unit> {
        val itemId = (card.origin as? InboxOrigin.Capture)?.itemId?.takeIf { it.isNotEmpty() }
            ?: return RepositoryResult.Failure(FailureKind.NOT_FOUND)
        return items.send(
            HttpMethod.Put,
            "/api/inbox/items/$itemId/type",
            body = InboxWire.changeType(typeId, card.version),
        ).ignoreBody()
    }

    override suspend fun reopen(cardId: String): RepositoryResult<Unit> =
        post(cardId, "reopen", InboxWire.version(null)).ignoreBody()

    private suspend fun post(cardId: String, action: String, body: JsonObject): ApiResponse =
        items.send(HttpMethod.Post, "/api/proposals/$cardId/$action", body = body)

    /** The card, with what an approval asks for read from its own request. */
    private suspend fun InboxCardDto.toCard(schema: CollectionSchema?): InboxCard {
        val approval = if (cardKind == "approval") approvalOf(cardId) else null
        return toCard(schema, approval)
    }

    private suspend fun approvalOf(id: String): InboxApproval? {
        val detail = items.send(HttpMethod.Get, "/api/approval-requests/$id").decode<InboxApprovalDto>()
        return (detail as? RepositoryResult.Content)?.value?.toApproval()
    }
}

private fun InboxOptionDto.toChoice() = InboxChoice(
    id = id,
    label = label,
    color = color,
    initials = initials,
    hint = hint,
    ref = ref,
    disabled = disabled,
    suggested = suggested,
    none = none,
)
