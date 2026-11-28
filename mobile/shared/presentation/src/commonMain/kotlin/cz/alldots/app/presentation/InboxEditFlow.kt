package cz.alldots.app.presentation

import cz.alldots.app.domain.InboxCard
import cz.alldots.app.domain.InboxChange
import cz.alldots.app.domain.InboxChoice
import cz.alldots.app.domain.InboxChoiceKeys
import cz.alldots.app.domain.InboxControl
import cz.alldots.app.domain.InboxField
import cz.alldots.app.domain.InboxInput
import cz.alldots.app.domain.applying
import cz.alldots.app.domain.change
import cz.alldots.app.domain.idsOf
import cz.alldots.app.domain.revisionOf
import cz.alldots.app.domain.visibleFields
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock

/**
 * What the person does to the fields of a card. A change shows at once on the card; the writes go to the server one
 * after the other, each on the card as the one before left it, and the server's answer replaces what was shown. A
 * write that fails is said so and the stack is read again.
 */
internal class InboxEditFlow(private val context: InboxFlowContext) {
    private val model = context.model

    fun handle(action: InboxAction) {
        when (action) {
            is InboxAction.SetText -> input(action.cardId, action.key, InboxInput.Text(action.text))
            is InboxAction.SetFlag -> input(action.cardId, action.key, InboxInput.Flag(action.on))
            is InboxAction.SetDate -> input(action.cardId, action.key, InboxInput.Date(action.date))
            is InboxAction.SetTime -> input(action.cardId, action.key, InboxInput.Time(action.time))
            is InboxAction.Pick -> pick(action)
            is InboxAction.Toggle -> toggle(action)
            is InboxAction.SetSecret -> secret(action)
            else -> Unit
        }
    }

    private fun pick(action: InboxAction.Pick) {
        val card = model.card(action.cardId)
        val field = card?.fieldOf(action.key)
        if (card == null || field == null) return
        val choice = model.choicesFor(card, field).firstOrNull { it.id == action.choiceId }
            ?: InboxChoice(action.choiceId, "", none = action.choiceId == null)
        when {
            field.key == InboxChoiceKeys.TYPE -> typed(card, action.choiceId)
            field.control == InboxControl.CHOICE ->
                card.revisionOf(field, choice)?.let { write(card.id, InboxChange.Revise(it)) }
            else -> input(card.id, field.key, InboxInput.Pick(choice))
        }
        if (field.control == InboxControl.SELECT) model.picker = null
        context.render()
    }

    private fun typed(card: InboxCard, typeId: String?) {
        model.answers[card.id] = model.answersOf(card.id).copy(typeId = typeId)
    }

    private fun toggle(action: InboxAction.Toggle) {
        val card = model.card(action.cardId) ?: return
        val ids = card.idsOf(action.key)
        val next = if (action.choiceId in ids) ids - action.choiceId else ids + action.choiceId
        input(action.cardId, action.key, InboxInput.Many(next))
    }

    private fun secret(action: InboxAction.SetSecret) {
        if (model.card(action.cardId) == null) return
        model.answers[action.cardId] = model.answersOf(action.cardId).copy(secret = action.text.ifEmpty { null })
        context.render()
    }

    private fun input(cardId: String, key: String, input: InboxInput) {
        val card = model.card(cardId)
        val field = card?.fieldOf(key)
        if (card != null && field != null) write(cardId, card.change(field, input))
    }

    private fun InboxCard.fieldOf(key: String): InboxField? = visibleFields().firstOrNull { it.key == key }

    private fun write(cardId: String, change: InboxChange) {
        val card = model.card(cardId)
        if (card == null || change == InboxChange.None) return
        if (change is InboxChange.Edit) model.replace(card.applying(change.edit))
        model.writing[cardId] = (model.writing[cardId] ?: 0) + 1
        context.render()
        context.host.scope.launch { send(cardId, change) }
    }

    private suspend fun send(cardId: String, change: InboxChange) {
        model.lock.withLock {
            val current = model.card(cardId)
            val answer = if (current == null) null else answer { context.deps.edit(current, change) }
            context.host.scope.ensureActive()
            val pending = (model.writing[cardId] ?: 1) - 1
            if (pending > 0) model.writing[cardId] = pending else model.writing.remove(cardId)
            when (answer) {
                null -> context.render()
                is Answer.Rejected -> context.failed(InboxProblem.EDIT, answer.kind)
                is Answer.Done -> saved(cardId, answer.value, pending)
            }
        }
    }

    /** Takes the server's card; while later writes are pending the card keeps their changes on screen. */
    private fun saved(cardId: String, saved: InboxCard?, pending: Int) {
        val current = model.card(cardId)
        if (current != null && saved != null) {
            model.replace(
                if (pending > 0) {
                    current.copy(
                        status = saved.status,
                        version = saved.version,
                        userValues = saved.userValues,
                        editedKeys = saved.editedKeys,
                        invalid = saved.invalid,
                    )
                } else {
                    saved
                },
            )
        }
        context.render()
    }
}
