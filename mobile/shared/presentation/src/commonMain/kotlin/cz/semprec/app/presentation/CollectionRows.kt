package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.PropertyKind

private const val MAX_SUBTITLE = 3
private const val MONTH_LENGTH = 7
private const val DAY_LENGTH = 10
private val SUBTITLE_TEXT_KINDS = setOf(PropertyKind.TEXT, PropertyKind.URL)

/** The row of [item]: its title, status, date and the few values that say what it is. */
internal fun CollectionItem.toRow(database: CollectionDatabase): CollectionRow {
    val titleProperty = database.title
    val title = (titleProperty?.let { values[it.key] } as? FieldValue.Text)?.text.orEmpty()
    val group = database.groupProperty()
    val groupContent = group?.let { contentOf(it, values[it.key]) } as? FieldContent.Choices
    val date = database.dateProperty()?.let { (contentOf(it, values[it.key]) as? FieldContent.Day)?.iso }
    val type = database.property("type")?.takeIf { database.uploadProperty() != null }
    val fileType = type?.let { (contentOf(it, values[it.key]) as? FieldContent.Choices)?.options?.firstOrNull()?.label }
    return CollectionRow(
        id = id,
        title = title,
        group = groupContent?.options?.firstOrNull(),
        date = date,
        subtitle = subtitleOf(database),
        fileType = fileType,
        rating = ratingOf(database),
    )
}

private const val RATING_KEY = "rating"
private const val MAX_RATING = 5

/** The stars of the item, from a number property `rating`; no value, 0 and anything above the stars are none. */
private fun CollectionItem.ratingOf(database: CollectionDatabase): Int? {
    val property = database.property(RATING_KEY)?.takeIf { it.kind == PropertyKind.NUMBER } ?: return null
    return (values[property.key] as? FieldValue.Number)?.number?.toInt()?.takeIf { it in 1..MAX_RATING }
}

/**
 * Time, context relations, the values of the facet bar property (a project's tags) and one plain text or link, in
 * this order, the empty ones left out.
 */
private fun CollectionItem.subtitleOf(database: CollectionDatabase): List<FieldContent> {
    val times = database.properties.filter { it.kind == PropertyKind.TIME && !it.system }
    val relations = database.contextRelations().take(2)
    val bar = listOfNotNull(database.facetBarProperty?.let(database::property))
    val texts = database.properties.filter { it.kind in SUBTITLE_TEXT_KINDS && it.key !in HIDDEN_TEXT_KEYS }
    return (times + relations + bar + texts)
        .map { contentOf(it, values[it.key]) }
        .filter { it != FieldContent.Empty }
        .take(MAX_SUBTITLE)
}

private val HIDDEN_TEXT_KEYS = setOf("icon", "color", "icalUid", "place", "url", "link")

/**
 * Groups the ordered [rows] under headings. A board always groups by status; a list groups by what it is ordered
 * by: dates into days or months (items before today and without a date get the server's own headings), statuses
 * into their options, titles into letters.
 */
internal fun sectionsOf(
    rows: List<CollectionRow>,
    database: CollectionDatabase,
    layout: CollectionLayout,
    axis: SortAxis?,
    today: String,
): List<CollectionSection> {
    val effective = if (layout == CollectionLayout.BOARD) SortAxis.GROUP else axis
    return when (effective) {
        SortAxis.GROUP -> byOption(rows, database)
        SortAxis.DATE -> byDate(rows, database, today)
        SortAxis.TITLE -> rows.groupSections { row ->
            SectionHead(SectionKind.LETTER, row.title.take(1).uppercase(), "", null)
        }
        SortAxis.CREATED, null -> listOf(CollectionSection(SectionKind.NONE, "", "", null, rows))
    }.filter { it.rows.isNotEmpty() || layout == CollectionLayout.BOARD }
}

private data class SectionHead(val kind: SectionKind, val key: String, val label: String, val color: String?)

/** Rows adjacent under the same head share a section, so the server's order is kept inside and across sections. */
private fun List<CollectionRow>.groupSections(head: (CollectionRow) -> SectionHead): List<CollectionSection> {
    val sections = mutableListOf<CollectionSection>()
    for (row in this) {
        val next = head(row)
        val last = sections.lastOrNull()
        if (last != null && last.kind == next.kind && last.key == next.key) {
            sections[sections.lastIndex] = last.copy(rows = last.rows + row)
        } else {
            sections += CollectionSection(next.kind, next.key, next.label, next.color, listOf(row))
        }
    }
    return sections
}

/** Every option of the status gets a section, in the option order, so an empty board column still shows. */
private fun byOption(rows: List<CollectionRow>, database: CollectionDatabase): List<CollectionSection> {
    val options = database.groupProperty()?.optionViews().orEmpty()
    val known = options.map { option ->
        CollectionSection(
            SectionKind.OPTION,
            option.key,
            option.label,
            option.color,
            rows.filter { it.group?.key == option.key },
        )
    }
    val without = rows.filter { row -> options.none { it.key == row.group?.key } }
    return if (without.isEmpty()) known else known + CollectionSection(SectionKind.NO_VALUE, "", "", null, without)
}

private fun byDate(rows: List<CollectionRow>, database: CollectionDatabase, today: String): List<CollectionSection> {
    val labels = database.dateLabels
    val daily = database.key == EVENTS_KEY
    return rows.groupSections { row ->
        val day = row.date?.take(DAY_LENGTH)
        when {
            day == null -> SectionHead(SectionKind.NO_VALUE, "", labels?.noDate.orEmpty(), null)
            labels != null && day < today -> SectionHead(SectionKind.PAST, "", labels.past, null)
            daily -> SectionHead(SectionKind.DAY, day, "", null)
            else -> SectionHead(SectionKind.MONTH, day.take(MONTH_LENGTH), "", null)
        }
    }
}

private const val EVENTS_KEY = "events"
