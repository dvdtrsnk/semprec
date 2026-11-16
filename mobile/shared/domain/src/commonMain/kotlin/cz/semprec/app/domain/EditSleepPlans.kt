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
}
