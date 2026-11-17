package cz.semprec.app.data

import cz.semprec.app.core.ItemKind

/** The keys of the tasks and events databases and of their properties and relations that the app reads and writes. */
internal object WorkKeys {
    const val TASKS = "tasks"
    const val EVENTS = "events"
    const val PROJECTS = "projects"
    const val AREAS = "areas"
    const val PEOPLE = "people"
    const val NAME = "name"
    const val STATUS = "status"
    const val SYSTEM_ACTIVE = "systemActive"
    const val DATE = "date"
    const val END_DATE = "endDate"
    const val TIME_FROM = "timeFrom"
    const val TIME_TO = "timeTo"
    const val FLAGGED = "flagged"
    const val DESCRIPTION = "description"
    const val PLACE = "place"
    const val EFFECTIVE_DATE = "effectiveDate"
    const val RECURRENCE = "recurrence"
    const val COLOR = "color"
    const val PROJECT = "project"
    const val AREA = "area"
    const val FILES = "files"
    const val HOST_EVENTS = "hostEvents"
    const val COMPANY = "company"

    fun databaseKey(kind: ItemKind): String = if (kind == ItemKind.TASK) TASKS else EVENTS

    /** The relations a task list expands: the project, and through it the area. */
    val listRelations: Map<String, List<String>> = mapOf(PROJECT to listOf(AREA))

    /** The relations the Podrobnosti sheet expands. */
    fun detailRelations(kind: ItemKind): Map<String, List<String>> = when (kind) {
        ItemKind.TASK -> listRelations + mapOf(PEOPLE to emptyList(), FILES to emptyList(), HOST_EVENTS to emptyList())
        ItemKind.EVENT -> listRelations + mapOf(PEOPLE to emptyList(), FILES to emptyList(), COMPANY to emptyList())
    }
}
