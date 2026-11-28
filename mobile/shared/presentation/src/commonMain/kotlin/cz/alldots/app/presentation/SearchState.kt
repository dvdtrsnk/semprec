package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.SearchGroupType
import cz.alldots.app.core.SearchSubtitleKind

/** What the search overlay shows: the recent searches, a wait, the results, no match, or a failure. */
enum class SearchPhase { RECENTS, SEARCHING, RESULTS, EMPTY, ERROR }

/** One piece of a result's subtitle; the app composes its text from [kind] and the canonical [value]. */
data class SearchSubtitleItem(val kind: SearchSubtitleKind, val value: String, val itemId: String?)

/**
 * One match. [key] identifies it within its group: the thread of a mail or chat match, the item of any other.
 * [snippet] is a plain-text excerpt from the match, [journalType] and [journalPeriod] name a journal day.
 */
data class SearchResultItem(
    val key: String,
    val itemId: String?,
    val threadId: String?,
    val databaseKey: String?,
    val title: String,
    val subtitle: List<SearchSubtitleItem>,
    val snippet: String?,
    val journalType: String?,
    val journalPeriod: String?,
)

/** The matches of one kind; [total] counts every match, [results] are the ones listed. */
data class SearchGroupItem(val type: SearchGroupType, val total: Int, val results: List<SearchResultItem>)

/**
 * The search overlay. The text being typed stays in the native field and is handed over by
 * [SearchAction.QueryChanged]. [scope] is the kind searched, `null` for all of them. While [phase] is
 * [SearchPhase.SEARCHING], [groups] still holds the answer to the earlier text, so the list does not flash.
 */
data class SearchState(
    val phase: SearchPhase = SearchPhase.RECENTS,
    val failure: FailureKind? = null,
    val scope: SearchGroupType? = null,
    val recents: List<String> = emptyList(),
    val groups: List<SearchGroupItem> = emptyList(),
)
