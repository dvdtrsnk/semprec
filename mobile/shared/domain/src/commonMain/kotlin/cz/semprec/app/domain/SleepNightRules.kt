package cz.semprec.app.domain

/** Whether a night of sleep whose times change still follows its plan. */
object SleepNightRules {
    /**
     * Whether [night] with the times [bed] and [wake] differs from its plan: it was changed already, or a time is not
     * the plan's. A night without a plan's time is never changed from it.
     */
    fun isChanged(night: SleepNightEntry, bed: ClockTime, wake: ClockTime): Boolean =
        night.changed || night.planBed?.let { it != bed } == true || night.planWake?.let { it != wake } == true
}
