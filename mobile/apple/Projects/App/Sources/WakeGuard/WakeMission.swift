import Foundation

/// A wake-up alarm that only a code ends: the alarm itself, the codes that end it, and the watch alarms scheduled
/// after its next ring, which keep ringing whatever the system's Stop button did until a code is shown.
struct WakeMission: Codable, Equatable, Identifiable, Sendable {

    let id: UUID
    let title: String
    let time: AlarmTime
    /// The codes of barcodes or QR codes, any one of which ends the alarm, compared as scanned.
    let codes: [String]
    /// The id of the alarm the person set, which rings at `time`.
    let alarmID: UUID
    /// The ring the watch alarms guard; nil while none is guarded.
    var guardedRing: Date?
    /// The ids of the watch alarms after `guardedRing`.
    var watchIDs: [UUID]
}

// MARK: - Rings
extension WakeMission {

    /// The minutes after a ring at which a watch alarm rings: every minute for half an hour, then every five minutes
    /// up to two hours. They are on the system's timers before the person sleeps, because once the alarm rings the
    /// app may never run again until the person opens it.
    static let watchOffsets: [Int] = Array(1...30) + Array(stride(from: 35, through: 120, by: 5))

    /// How long the alarm rings before the person may tap instead of scanning.
    static let tapFallbackDelay: TimeInterval = 10 * 60

    /// How many taps end the alarm once the tap fallback is open.
    static let requiredTaps = 200

    /// The first ring at or after `now`; nil for a single ring that has passed.
    func nextRing(after now: Date, calendar: Calendar = .current) -> Date? {
        switch time {
        case .once(let date):
            return date >= now ? date : nil
        case .daily(let hour, let minute):
            return calendar.nextDate(
                after: now.addingTimeInterval(-1),
                matching: DateComponents(hour: hour, minute: minute, second: 0),
                matchingPolicy: .nextTime
            )
        }
    }

    /// Whether `code` is one of the codes that end the alarm; surrounding whitespace does not count.
    func accepts(_ code: String) -> Bool {
        let scanned = code.trimmingCharacters(in: .whitespacesAndNewlines)
        return !scanned.isEmpty && codes.contains(scanned)
    }
}
