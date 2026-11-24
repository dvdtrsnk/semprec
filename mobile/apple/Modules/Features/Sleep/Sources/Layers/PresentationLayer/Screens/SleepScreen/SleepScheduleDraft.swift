import CoreKit
import Foundation

/// A schedule while the schedule editor changes it: its days, its bedtime, how long it lasts and its alarm. The wake
/// time follows from the bedtime and the length, so the two ends of the dial move as one snake: shortening it below
/// `minimumMinutes` or lengthening it above `maximumMinutes` pushes the other end along instead.
struct SleepScheduleDraft: Equatable {

    /// The step of every time on the dial.
    static let stepMinutes = 5
    static let minutesInDay = 1_440
    /// The shortest schedule: below it, a dragged end pushes the other one.
    static let minimumMinutes = 60
    /// The longest schedule. A bedtime before noon must not reach past midnight, which the server reads as a night
    /// of no length, and a bedtime before noon plus twelve hours never does.
    static let maximumMinutes = 12 * 60

    var days: Set<Int>
    /// Minutes after midnight, a multiple of `stepMinutes` once the dial moved it.
    private(set) var bedMinutes: Int
    private(set) var durationMinutes: Int
    var alarm: Bool

    // MARK: - Init
    init(days: Set<Int>, bedMinutes: Int, wakeMinutes: Int, alarm: Bool) {
        self.days = days
        self.bedMinutes = Self.wrapped(bedMinutes)
        self.alarm = alarm
        durationMinutes = Self.clamped(Self.wrapped(wakeMinutes - bedMinutes))
    }

    // MARK: - Times
    var wakeMinutes: Int {
        Self.wrapped(bedMinutes + durationMinutes)
    }

    /// Moves the bedtime to `minutes`; the wake time stays unless the length leaves its range.
    mutating func moveBed(to minutes: Int) {
        let delta = Self.signedDistance(from: bedMinutes, to: Self.snapped(minutes))
        bedMinutes = Self.wrapped(bedMinutes + delta)
        // A length out of its range stays at the limit, which moves the wake time with the bedtime.
        durationMinutes = Self.clamped(durationMinutes - delta)
    }

    /// Moves the wake time to `minutes`; the bedtime stays unless the length leaves its range.
    mutating func moveWake(to minutes: Int) {
        let delta = Self.signedDistance(from: wakeMinutes, to: Self.snapped(minutes))
        let targetWake = bedMinutes + durationMinutes + delta
        durationMinutes = Self.clamped(durationMinutes + delta)
        bedMinutes = Self.wrapped(targetWake - durationMinutes)
    }

    /// Moves the whole schedule so the bedtime is `minutes`; the length stays.
    mutating func moveAll(bedTo minutes: Int) {
        bedMinutes = Self.wrapped(Self.snapped(minutes))
    }

    // MARK: - Helpers
    /// `minutes` on the nearest step.
    static func snapped(_ minutes: Int) -> Int {
        let step = Double(stepMinutes)
        return wrapped(Int((Double(minutes) / step).rounded()) * stepMinutes)
    }

    static func wrapped(_ minutes: Int) -> Int {
        ((minutes % minutesInDay) + minutesInDay) % minutesInDay
    }

    /// The shorter way round the dial from `start` to `end`, in minutes: positive clockwise.
    static func signedDistance(from start: Int, to end: Int) -> Int {
        let forward = wrapped(end - start)
        return forward > minutesInDay / 2 ? forward - minutesInDay : forward
    }

    static func clamped(_ duration: Int) -> Int {
        min(max(duration, minimumMinutes), maximumMinutes)
    }
}
