package cz.alldots.app.presentation

import cz.alldots.app.domain.InboxAnswers
import cz.alldots.app.domain.InboxCard
import cz.alldots.app.domain.InboxChoice
import cz.alldots.app.domain.InboxType
import kotlinx.coroutines.sync.Mutex

/** The picker that is open: the field [key] of the card [cardId]. */
internal data class InboxPickerRef(val cardId: String, val key: String)

/** A decision the person made in this visit, which Undo can take back. */
internal data class InboxDecision(val cardId: String, val approved: Boolean)

/**
 * What the Inbox holds apart from its screen state: the cards as the domain knows them, the person's answers that no
 * card holds (the type of a clarified capture, the secret of a server), the choices of the item pickers and what is
 * being written. The flows of the screen change it; [InboxViewModel] shows it.
 */
internal class InboxModel {
    var cards: List<InboxCard> = emptyList()
    var types: List<InboxType> = emptyList()
    var picker: InboxPickerRef? = null
    var handled = 0
    var dropped = 0

    val answers = mutableMapOf<String, InboxAnswers>()
    val choices = mutableMapOf<String, List<InboxChoice>>()
    val asked = mutableSetOf<String>()
    val failed = mutableSetOf<String>()
    val writing = mutableMapOf<String, Int>()
    val decisions = ArrayDeque<InboxDecision>()

    /** Edits and decisions go one after the other, each on the card as the one before left it. */
    val lock = Mutex()

    fun card(id: String): InboxCard? = cards.firstOrNull { it.id == id }

    fun answersOf(id: String): InboxAnswers = answers[id] ?: InboxAnswers()

    fun replace(card: InboxCard) {
        cards = cards.map { if (it.id == card.id) card else it }
    }

    fun remove(id: String) {
        cards = cards.filterNot { it.id == id }
        answers.remove(id)
        writing.remove(id)
    }

    fun choicesKey(cardId: String, source: String) = "$cardId|$source"

    /** Forgets what belongs to cards that are not in the stack any more. */
    fun prune() {
        val ids = cards.map { it.id }.toSet()
        answers.keys.retainAll(ids)
        writing.keys.retainAll(ids)
        choices.keys.retainAll { key -> key.substringBefore('|') in ids }
        asked.retainAll { key -> key.substringBefore('|') in ids }
        failed.retainAll { key -> key.substringBefore('|') in ids }
        if (picker?.cardId !in ids) picker = null
    }
}
