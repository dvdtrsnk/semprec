import CoreKit

// MARK: - A night moved by a finger
extension CalendarSleep {

    /// Noon, from which a bedtime runs through midnight, as the server counts a night.
    static let noon = 12 * 60

    /// The same night with other times, its length and its goal worked out again as the server counts them.
    func moved(bed: Int, wake: Int) -> CalendarSleep {
        let duration = bed >= Self.noon ? CalendarGeometry.minutesPerDay - bed + wake : max(0, wake - bed)
        return CalendarSleep(
            night: night,
            bedMinutes: bed,
            wakeMinutes: wake,
            alarm: alarm,
            changed: changed || planBedMinutes.map { bed != $0 } == true || planWakeMinutes.map { wake != $0 } == true,
            prepMinutes: prepMinutes,
            planBedMinutes: planBedMinutes,
            planWakeMinutes: planWakeMinutes,
            durationMinutes: duration,
            goalMinutes: goalMinutes,
            meetsGoal: goalMinutes.map { duration >= $0 }
        )
    }
}
