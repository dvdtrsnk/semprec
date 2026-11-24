import Foundation

/// What the app asks of the system's alarms: the permission, the alarms this app scheduled, and scheduling or
/// cancelling one. Plain values cross it, so callers never hold AlarmKit's types, which macOS does not have.
protocol AlarmScheduler: Sendable {

    /// Whether this platform rings system alarms at all; macOS does not.
    var isSupported: Bool { get }

    /// What the person allowed, without asking.
    func authorization() -> AlarmAuthorization

    /// Asks the person the first time; afterwards answers what they chose.
    func requestAuthorization() async throws -> AlarmAuthorization

    /// The alarms of this app the system holds now.
    func alarms() throws -> [ScheduledAlarm]

    /// Hands one alarm to the system, which rings it even in silent mode and through a Focus.
    @discardableResult
    func schedule(_ request: AlarmRequest) async throws -> ScheduledAlarm

    func cancel(id: UUID) throws

    /// Every change of this app's alarms, starting with the current ones, until the caller stops listening.
    func updates() -> AsyncStream<[ScheduledAlarm]>
}

/// The person's answer to the alarms permission.
enum AlarmAuthorization: Equatable, Sendable {

    case notDetermined
    case denied
    case authorized
    /// The platform has no system alarms (macOS).
    case unsupported
}

/// One alarm to schedule: its title in the alert and when it rings.
struct AlarmRequest: Equatable, Sendable {

    let title: String
    let schedule: AlarmTime
}

/// When an alarm rings.
enum AlarmTime: Equatable, Sendable {

    /// Once, at this moment; a change of time zone does not move it.
    case once(Date)
    /// Every day at this local time, following the device's time zone.
    case daily(hour: Int, minute: Int)
}

/// One alarm the system holds for this app.
struct ScheduledAlarm: Identifiable, Equatable, Sendable {

    let id: UUID
    /// Nil for an alarm without a schedule (a countdown) or with one this app does not create (a weekly pattern other
    /// than every day).
    let time: AlarmTime?
    let phase: AlarmPhase
}

/// Where an alarm is in its life.
enum AlarmPhase: Equatable, Sendable {

    case scheduled
    case countdown
    case paused
    case alerting
}

/// Why the system refused an alarm, where the reason is one the app can name.
enum AlarmSchedulingError: Error, Equatable {

    /// The person refused alarms for this app.
    case notAuthorized
    /// The system holds as many alarms of this app as it allows.
    case limitReached
    /// The platform has no system alarms (macOS).
    case unsupported
}
