package cz.semprec.app.presentation

import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxControl
import cz.semprec.app.domain.InboxField
import cz.semprec.app.domain.visibleFields
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The items a select or a multi-value field offers (the projects, the pages), which the server lists per
 * card. The top cards ask for theirs as soon as they are shown, so that a value reads as a name and not as an id; a
 * picker that opens before they are there waits for them, and asks again after a failure.
 */
internal class InboxOptionsFlow(private val context: InboxFlowContext) {
    private val model = context.model

    fun handle(action: InboxAction) {
        when (action) {
            is InboxAction.OpenPicker -> open(action.cardId, action.key)
            InboxAction.ClosePicker -> {
                model.picker = null
                context.render()
            }
            else -> Unit
        }
    }

    /** Asks for the items of every field of the top cards that has not got them yet. */
    fun prefetch() {
        model.cards.take(PREFETCHED_CARDS).forEach { card ->
            card.visibleFields().mapNotNull { it.optionsSource }.distinct().forEach { source ->
                if (model.choicesKey(card.id, source) !in model.asked) fetch(card, source)
            }
        }
    }

    private fun open(cardId: String, key: String) {
        val card = model.card(cardId)
        val field = card?.visibleFields()?.firstOrNull { it.key == key }
        if (card == null || field == null || !field.opensPicker()) return
        model.picker = InboxPickerRef(cardId, key)
        val source = field.optionsSource
        if (source != null && model.choicesKey(cardId, source) !in model.choices) fetch(card, source)
        context.render()
    }

    private fun InboxField.opensPicker() = control == InboxControl.SELECT || control == InboxControl.MULTI

    private fun fetch(card: InboxCard, source: String) {
        val key = model.choicesKey(card.id, source)
        if (!model.asked.add(key) && key !in model.failed) return
        model.failed.remove(key)
        context.host.scope.launch {
            val answer = answer { context.deps.repository.options(card, source) }
            context.host.scope.ensureActive()
            when (answer) {
                is Answer.Rejected -> model.failed += key
                is Answer.Done -> model.choices[key] = answer.value
            }
            context.render()
        }
    }

    private companion object {
        const val PREFETCHED_CARDS = 2
    }
}
