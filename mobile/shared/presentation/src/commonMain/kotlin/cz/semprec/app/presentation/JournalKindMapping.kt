package cz.semprec.app.presentation

import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.PageBlockType

internal fun JournalPeriodKind.toType(): JournalPeriodType = when (this) {
    JournalPeriodKind.YEAR -> JournalPeriodType.YEAR
    JournalPeriodKind.QUARTER -> JournalPeriodType.QUARTER
    JournalPeriodKind.MONTH -> JournalPeriodType.MONTH
    JournalPeriodKind.WEEK -> JournalPeriodType.WEEK
    JournalPeriodKind.DAY -> JournalPeriodType.DAY
}

internal fun JournalPeriodType.toKind(): JournalPeriodKind = when (this) {
    JournalPeriodType.YEAR -> JournalPeriodKind.YEAR
    JournalPeriodType.QUARTER -> JournalPeriodKind.QUARTER
    JournalPeriodType.MONTH -> JournalPeriodKind.MONTH
    JournalPeriodType.WEEK -> JournalPeriodKind.WEEK
    JournalPeriodType.DAY -> JournalPeriodKind.DAY
}

internal fun JournalBlockKind.toType(): PageBlockType = when (this) {
    JournalBlockKind.TEXT -> PageBlockType.TEXT
    JournalBlockKind.H1 -> PageBlockType.H1
    JournalBlockKind.H2 -> PageBlockType.H2
    JournalBlockKind.H3 -> PageBlockType.H3
    JournalBlockKind.BULLET -> PageBlockType.BULLET
    JournalBlockKind.NUMBER -> PageBlockType.NUMBER
    JournalBlockKind.TODO -> PageBlockType.TODO
    JournalBlockKind.QUOTE -> PageBlockType.QUOTE
    JournalBlockKind.PAGE -> PageBlockType.PAGE
}

internal fun PageBlockType.toKind(): JournalBlockKind = when (this) {
    PageBlockType.TEXT -> JournalBlockKind.TEXT
    PageBlockType.H1 -> JournalBlockKind.H1
    PageBlockType.H2 -> JournalBlockKind.H2
    PageBlockType.H3 -> JournalBlockKind.H3
    PageBlockType.BULLET -> JournalBlockKind.BULLET
    PageBlockType.NUMBER -> JournalBlockKind.NUMBER
    PageBlockType.TODO -> JournalBlockKind.TODO
    PageBlockType.QUOTE -> JournalBlockKind.QUOTE
    PageBlockType.PAGE -> JournalBlockKind.PAGE
}
