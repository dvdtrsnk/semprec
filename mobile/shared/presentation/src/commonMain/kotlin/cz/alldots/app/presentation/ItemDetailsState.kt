package cz.alldots.app.presentation

import cz.alldots.app.core.EntityRef
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.ItemKind
import cz.alldots.app.core.ProjectRef
import cz.alldots.app.core.TaskRepeat
import cz.alldots.app.core.ValueLink

enum class ItemDetailsPhase { LOADING, CONTENT, ERROR }

/** Whether the project and people a person can pick are loaded; they load when the first picker opens. */
enum class ChoicesPhase { IDLE, LOADING, READY, ERROR }

/**
 * The Podrobnosti sheet of a task or an event. Times are `HH:mm` and days `yyyy-MM-dd`; a missing [timeFrom] is an
 * item that lasts all day ([allDay] is only for events: a task without a time has none). [lengthMinutes] is derived
 * from start and end. Fields the other kind does not have stay at their empty value. [notice] is a failed write; the
 * sheet shows what the server holds again.
 */
data class ItemDetailsState(
    val phase: ItemDetailsPhase = ItemDetailsPhase.LOADING,
    val failure: FailureKind? = null,
    val kind: ItemKind = ItemKind.TASK,
    val title: String = "",
    val done: Boolean = false,
    val description: String = "",
    val place: String = "",
    val flagged: Boolean = false,
    val date: String? = null,
    val endDate: String? = null,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val allDay: Boolean = false,
    val lengthMinutes: Int? = null,
    val repeat: TaskRepeat = TaskRepeat.NONE,
    val project: ProjectRef? = null,
    val people: List<EntityRef> = emptyList(),
    val files: List<EntityRef> = emptyList(),
    val hostEvents: List<EntityRef> = emptyList(),
    val company: EntityRef? = null,
    val projectLink: ValueLink? = null,
    val peopleLink: ValueLink? = null,
    val choices: ChoicesPhase = ChoicesPhase.IDLE,
    val projectChoices: List<ProjectRef> = emptyList(),
    val personChoices: List<EntityRef> = emptyList(),
    val notice: FailureKind? = null,
)
