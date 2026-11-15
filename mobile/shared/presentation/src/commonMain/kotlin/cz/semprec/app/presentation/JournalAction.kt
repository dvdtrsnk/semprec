package cz.semprec.app.presentation

sealed interface JournalAction {
    /** Reads the selected period again; also what the person chooses after a stale edit. */
    data object Retry : JournalAction

    /** Shows the period of [kind] that starts on [start] (`YYYY-MM-DD`). */
    data class Select(val kind: JournalPeriodKind, val start: String) : JournalAction

    data object GoToday : JournalAction
    data class OpenEvent(val id: String) : JournalAction
    data object OpenInbox : JournalAction
    data class OpenPage(val pageId: String, val title: String) : JournalAction

    /** Replaces the text of block [index] of [page] with the plain [text] typed. */
    data class SetText(val page: JournalPageRef, val index: Int, val text: String) : JournalAction
    data class ToggleDone(val page: JournalPageRef, val index: Int) : JournalAction
    data class AddBlock(val page: JournalPageRef, val kind: JournalBlockKind, val text: String) : JournalAction

    /** Hides the message about the last failed change. */
    data object DismissProblem : JournalAction
}

sealed interface JournalEffect {
    data class OpenEvent(val id: String) : JournalEffect
    data object OpenInbox : JournalEffect
    data class OpenPage(val pageId: String, val title: String) : JournalEffect
}

sealed interface JournalSubpageAction {
    data object Retry : JournalSubpageAction
    data class SetText(val index: Int, val text: String) : JournalSubpageAction
    data class ToggleDone(val index: Int) : JournalSubpageAction
    data class AddBlock(val kind: JournalBlockKind, val text: String) : JournalSubpageAction
    data class OpenPage(val pageId: String, val title: String) : JournalSubpageAction
    data object DismissProblem : JournalSubpageAction
}

sealed interface JournalSubpageEffect {
    data class OpenPage(val pageId: String, val title: String) : JournalSubpageEffect
}
