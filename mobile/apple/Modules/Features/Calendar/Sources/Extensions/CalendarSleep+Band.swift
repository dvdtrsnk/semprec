import CoreKit

// MARK: - Band
extension CalendarSleep {

    /// The part of the day the night covers, as minutes of the day, or nil when this day holds none of it (only the
    /// bedtime reminder, or nothing). The shared layer cut it; this is the one place that says "empty".
    var band: Range<Int>? {
        fromMinutes < toMinutes ? fromMinutes..<toMinutes : nil
    }
}

/// What the day timeline draws of the sleep on one day: a band of a night, or its bedtime reminder.
enum CalendarSleepPart: Equatable {

    /// The band of `sleep`; the evening one is labelled with the bedtime, the morning one with the wake time.
    case band(CalendarSleep, Range<Int>, isEvening: Bool)
    case reminder(CalendarSleep, minutes: Int)
}

// MARK: - Parts
extension CalendarDayState {

    /// The evening's night first, then the morning's: each with its band when the night reaches this day, and its
    /// reminder when it comes on this day.
    var sleepParts: [CalendarSleepPart] {
        var parts: [CalendarSleepPart] = []
        for (sleep, isEvening) in [(sleepEvening, true), (sleepMorning, false)] {
            guard let sleep else { continue }
            if let band = sleep.band { parts.append(.band(sleep, band, isEvening: isEvening)) }
            if let minutes = sleep.prepMinutes { parts.append(.reminder(sleep, minutes: minutes)) }
        }
        return parts
    }
}

// MARK: - A night moved by a finger
extension CalendarDayState {

    /// The parts of the sleep on this day while `drag` moves a night: that night's evening and morning are the parts
    /// the shared layer cut for the times it is moving to.
    func sleepParts(dragging drag: CalendarSleepDrag?) -> [CalendarSleepPart] {
        guard let drag else { return sleepParts }
        let evening = date == drag.night ? drag.evening : sleepEvening
        let morning = date == drag.morningDay ? drag.morning : sleepMorning
        return CalendarDayState(date: date, items: items, sleepEvening: evening, sleepMorning: morning).sleepParts
    }
}
