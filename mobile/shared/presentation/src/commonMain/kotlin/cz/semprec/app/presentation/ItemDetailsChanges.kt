package cz.semprec.app.presentation

import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.ScheduleRules
import cz.semprec.app.domain.WorkItem
import cz.semprec.app.domain.singleLineTitle

/** What an edit of the Podrobnosti sheet asks the server to change; `null` for an edit that changes nothing. */
internal object ItemDetailsChanges {
    fun of(action: ItemDetailsAction, item: WorkItem): ItemChange? =
        field(action, item) ?: relation(action, item) ?: schedule(action, item)

    private fun field(action: ItemDetailsAction, item: WorkItem): ItemChange? = when (action) {
        is ItemDetailsAction.SetTitle ->
            singleLineTitle(action.title).takeIf { it.isNotEmpty() }?.let { ItemChange.Title(it) }
        ItemDetailsAction.ToggleDone -> ItemChange.Done(item.status != TaskStatus.DONE)
        is ItemDetailsAction.SetDescription -> ItemChange.Description(action.text)
        is ItemDetailsAction.SetPlace -> ItemChange.Place(action.text)
        is ItemDetailsAction.SetFlagged -> ItemChange.Flagged(action.flagged)
        is ItemDetailsAction.SetRepeat -> ItemChange.Repeat(action.repeat)
        else -> null
    }

    private fun relation(action: ItemDetailsAction, item: WorkItem): ItemChange? = when (action) {
        is ItemDetailsAction.SelectProject -> ItemChange.Project(action.projectId)
        is ItemDetailsAction.TogglePerson ->
            if (item.people.any { it.id == action.personId }) {
                ItemChange.RemovePerson(action.personId)
            } else {
                ItemChange.AddPerson(action.personId)
            }
        is ItemDetailsAction.RemoveFile -> ItemChange.RemoveFile(action.fileId)
        is ItemDetailsAction.Unlink -> ItemChange.Unlink(action.value)
        is ItemDetailsAction.Relink -> ItemChange.Relink(action.value)
        else -> null
    }

    private fun schedule(action: ItemDetailsAction, item: WorkItem): ItemChange? {
        val current = item.schedule
        val next = when (action) {
            is ItemDetailsAction.SetDate -> withDate(item, action.date)
            is ItemDetailsAction.SetTimed ->
                if (action.timed) ScheduleRules.withDefaultStart(current) else ScheduleRules.withTimeFrom(current, null)
            is ItemDetailsAction.SetEnded ->
                if (action.ended) ScheduleRules.withDefaultEnd(current) else ScheduleRules.withTimeTo(current, null)
            is ItemDetailsAction.SetTimeFrom -> ScheduleRules.withTimeFrom(current, action.time)
            is ItemDetailsAction.SetTimeTo -> ScheduleRules.withTimeTo(current, action.time)
            is ItemDetailsAction.SetAllDay ->
                ScheduleRules.withAllDay(current, action.allDay).takeIf { item.kind == ItemKind.EVENT }
            else -> null
        }
        return next?.takeIf { it != current }?.let { ItemChange.Reschedule(it) }
    }

    /** An event always has a day, so only a task loses it. */
    private fun withDate(item: WorkItem, date: String?): Schedule? = when {
        date != null -> ScheduleRules.withDate(item.schedule, date)
        item.kind == ItemKind.TASK -> ScheduleRules.withDate(item.schedule, null)
        else -> null
    }
}
