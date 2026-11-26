package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/**
 * The edits of the sleep plans. A weekday is in at most one plan: switching a day on in one plan writes only that
 * plan, and the server takes the day from the plan that held it.
 */
class EditSleepPlans(private val repository: SleepRepository) {
    suspend fun toggleDay(plans: List<SleepPlan>, planId: String, day: Int): RepositoryResult<Unit> {
        val plan = plans.firstOrNull { it.id == planId }
        return if (plan == null || day !in SleepRules.WEEK) {
            RepositoryResult.Failure(FailureKind.NOT_FOUND)
        } else {
            repository.updatePlan(planId, SleepPlanChange(wakeDays = SleepRules.toggledDays(plan, day)))
        }
    }

    suspend fun setBed(planId: String, bed: ClockTime): RepositoryResult<Unit> =
        if (SleepRules.isSleepTime(bed)) {
            repository.updatePlan(planId, SleepPlanChange(bed = bed))
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }

    suspend fun setWake(planId: String, wake: ClockTime): RepositoryResult<Unit> =
        if (SleepRules.isSleepTime(wake)) {
            repository.updatePlan(planId, SleepPlanChange(wake = wake))
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }

    suspend fun setAlarm(planId: String, alarm: Boolean): RepositoryResult<Unit> =
        repository.updatePlan(planId, SleepPlanChange(alarm = alarm))

    /** Adds a plan for the days no plan holds and answers its id; no free day is a refusal. */
    suspend fun add(plans: List<SleepPlan>, name: String): RepositoryResult<String> {
        val plan = SleepRules.newPlan(plans, name)
        return if (plan == null || name.isBlank()) {
            RepositoryResult.Failure(FailureKind.REJECTED)
        } else {
            repository.createPlan(plan)
        }
    }

    /** Deletes a plan unless it is the last one. */
    suspend fun delete(plans: List<SleepPlan>, planId: String): RepositoryResult<Unit> =
        if (SleepRules.canDeletePlan(plans) && plans.any { it.id == planId }) {
            repository.deletePlan(planId)
        } else {
            RepositoryResult.Failure(FailureKind.REJECTED)
        }

    /**
     * Writes a whole schedule at once: creates a plan named [name] after the last one when [planId] is null, else
     * changes the plan [planId]. It needs at least one weekday of the week, two start times and a night from
     * [SleepRules.SHORTEST_NIGHT_MINUTES] to [SleepRules.LONGEST_NIGHT_MINUTES] long; anything else is a
     * refusal. The days it takes leave the plans that held them on the server.
     */
    suspend fun save(
        plans: List<SleepPlan>,
        planId: String?,
        name: String,
        schedule: SleepSchedule,
    ): RepositoryResult<Unit> {
        val valid = schedule.wakeDays.isNotEmpty() &&
            schedule.wakeDays.all { it in SleepRules.WEEK } &&
            SleepRules.isSleepTime(schedule.bed) &&
            SleepRules.isSleepTime(schedule.wake) &&
            SleepRules.durationMinutes(schedule.bed, schedule.wake) in
            SleepRules.SHORTEST_NIGHT_MINUTES..SleepRules.LONGEST_NIGHT_MINUTES
        return when {
            !valid -> RepositoryResult.Failure(FailureKind.REJECTED)
            planId == null -> create(plans, name, schedule)
            plans.none { it.id == planId } -> RepositoryResult.Failure(FailureKind.NOT_FOUND)
            else -> repository.updatePlan(
                planId,
                SleepPlanChange(
                    wakeDays = schedule.wakeDays,
                    bed = schedule.bed,
                    wake = schedule.wake,
                    alarm = schedule.alarm,
                ),
            )
        }
    }

    private suspend fun create(plans: List<SleepPlan>, name: String, schedule: SleepSchedule): RepositoryResult<Unit> {
        if (name.isBlank()) return RepositoryResult.Failure(FailureKind.REJECTED)
        val plan = NewSleepPlan(
            name = name,
            wakeDays = schedule.wakeDays,
            bed = schedule.bed,
            wake = schedule.wake,
            alarm = schedule.alarm,
            position = (plans.maxOfOrNull { it.position } ?: -1) + 1,
        )
        return when (val created = repository.createPlan(plan)) {
            is RepositoryResult.Content -> RepositoryResult.Content(Unit)
            is RepositoryResult.Failure -> created
        }
    }
}

/** The days and times of one schedule as the schedule editor writes them. */
data class SleepSchedule(
    val wakeDays: Set<Int>,
    val bed: ClockTime,
    val wake: ClockTime,
    val alarm: Boolean,
)
