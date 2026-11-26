import CoreKit

// MARK: - A night moved by a finger
extension CalendarSleep {

    /// Noon, from which a bedtime runs through midnight, as the server counts a night.
    static let noon = 12 * 60

    /// The same night with the times of `drag`, and the length and the goal the shared layer worked out for them.
    func moved(by drag: CalendarSleepDrag) -> CalendarSleep {
        CalendarSleep(
            night: night,
            bedMinutes: drag.bedMinutes,
            wakeMinutes: drag.wakeMinutes,
            alarm: alarm,
            changed: changed || planBedMinutes.map { drag.bedMinutes != $0 } == true
                || planWakeMinutes.map { drag.wakeMinutes != $0 } == true,
            prepMinutes: prepMinutes,
            planBedMinutes: planBedMinutes,
            planWakeMinutes: planWakeMinutes,
            durationMinutes: drag.durationMinutes,
            goalMinutes: goalMinutes,
            meetsGoal: drag.meetsGoal
        )
    }
}
