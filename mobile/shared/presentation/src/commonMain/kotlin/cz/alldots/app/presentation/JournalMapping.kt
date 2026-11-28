package cz.alldots.app.presentation

import cz.alldots.app.domain.InlineRun
import cz.alldots.app.domain.JournalAxisRow
import cz.alldots.app.domain.JournalEvent
import cz.alldots.app.domain.JournalInboxEntry
import cz.alldots.app.domain.JournalQuarterPage
import cz.alldots.app.domain.JournalWeekPage
import cz.alldots.app.domain.PageBlock
import cz.alldots.app.domain.PageBlockType
import cz.alldots.app.domain.PageMarkdown
import cz.alldots.app.domain.quarter

private const val MAX_INDENT = 5

private fun InlineRun.toRun() = JournalRun(text, bold, italic, code, link)

/** The blocks of a page's Markdown, with the numbers of numbered lists counted. */
internal fun markdownToBlocks(markdown: String?): List<JournalBlock> {
    val counters = IntArray(MAX_INDENT + 1)
    return PageMarkdown.parse(markdown.orEmpty()).mapIndexed { index, block ->
        JournalBlock(
            index = index,
            kind = block.type.toKind(),
            indent = block.indent,
            done = block.done,
            ordinal = ordinalOf(block, counters),
            runs = block.runs.map { it.toRun() },
            pageId = block.pageId,
        )
    }
}

/** The number of a numbered item and the bookkeeping that restarts the count of lists nested below any other block. */
private fun ordinalOf(block: PageBlock, counters: IntArray): Int {
    val isNumber = block.type == PageBlockType.NUMBER
    val isList = isNumber || block.type == PageBlockType.BULLET || block.type == PageBlockType.TODO
    val resetFrom = if (isNumber) block.indent + 1 else if (isList) block.indent else 0
    for (level in resetFrom..MAX_INDENT) counters[level] = 0
    if (isNumber) counters[block.indent] += 1
    return if (isNumber) counters[block.indent] else 0
}

internal fun pageState(ref: JournalPageRef, markdown: String?) = JournalPageState(ref, markdownToBlocks(markdown))

internal fun JournalWeekPage.toState() = JournalWeekState(
    number = week,
    from = from.toString(),
    to = to.toString(),
    page = pageState(JournalPageRef(JournalPeriodKind.WEEK, period), markdown),
)

internal fun JournalQuarterPage.toState() = JournalQuarterState(
    number = quarter,
    from = from.toString(),
    to = to.toString(),
    page = pageState(JournalPageRef(JournalPeriodKind.QUARTER, period), markdown),
)

internal fun JournalEvent.toState() = JournalEventState(
    id = id,
    title = title,
    startMinutes = if (allDay) null else timeFrom?.minutes,
    endMinutes = if (allDay) null else timeTo?.minutes,
    allDay = allDay,
    place = place,
    projectName = projectName,
    projectColor = projectColor,
    hasTranscript = hasTranscript,
)

internal fun JournalInboxEntry.toState() = JournalInboxState(
    id = id,
    time = time,
    text = text,
    emoji = typeEmoji,
    status = inboxStatus(processing ?: status),
    attachments = attachments.map { it.toState() },
)

private fun inboxStatus(key: String?): JournalInboxStatus = when (key) {
    "waiting" -> JournalInboxStatus.WAITING
    "pending" -> JournalInboxStatus.PENDING
    "failed" -> JournalInboxStatus.FAILED
    "needsClarification" -> JournalInboxStatus.NEEDS_CLARIFICATION
    "proposed" -> JournalInboxStatus.PROPOSED
    "confirmed" -> JournalInboxStatus.CONFIRMED
    "rejected" -> JournalInboxStatus.REJECTED
    "invalid" -> JournalInboxStatus.INVALID
    else -> JournalInboxStatus.NONE
}

internal fun List<JournalAxisRow>.toState(): List<JournalAxisRowState> = map { row ->
    JournalAxisRowState(
        kind = row.type.toKind(),
        cells = row.cells.map { cell ->
            JournalAxisCellState(
                kind = cell.type.toKind(),
                start = cell.start.toString(),
                year = cell.start.year,
                quarter = cell.start.quarter(),
                month = cell.start.month,
                day = cell.start.day,
                weekday = cell.start.isoDayOfWeek,
                onPath = cell.onPath,
                current = cell.current,
                today = cell.today,
            )
        },
    )
}
