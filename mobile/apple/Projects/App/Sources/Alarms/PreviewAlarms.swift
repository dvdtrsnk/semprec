import CoreKit
import Foundation

/// Alarms for the previews of the alarm screens: an authorized scheduler and stores that keep everything in memory,
/// so a preview never asks the system for the alarms permission or writes the app's defaults. Previews run on the
/// main actor, which is what makes the unchecked `Sendable` of these doubles sound.
final class PreviewAlarmScheduler: AlarmScheduler, @unchecked Sendable {

    private var held: [ScheduledAlarm] = []

    var isSupported: Bool { true }

    func authorization() -> AlarmAuthorization { .authorized }

    func requestAuthorization() async throws -> AlarmAuthorization { .authorized }

    func alarms() throws -> [ScheduledAlarm] { held }

    func schedule(_ request: AlarmRequest) async throws -> ScheduledAlarm {
        let alarm = ScheduledAlarm(id: request.id, time: request.schedule, phase: .scheduled)
        held.append(alarm)
        return alarm
    }

    func cancel(id: UUID) throws {
        held.removeAll { $0.id == id }
    }

    func stop(id: UUID) throws {
        held.removeAll { $0.id == id }
    }

    func updates() -> AsyncStream<[ScheduledAlarm]> {
        let alarms = held
        return AsyncStream { continuation in
            continuation.yield(alarms)
            continuation.finish()
        }
    }
}

/// The missions of a preview, in memory.
final class PreviewMissionStore: WakeMissionStore, @unchecked Sendable {

    private var missions: [WakeMission] = []

    func load() throws -> [WakeMission] { missions }

    func save(_ missions: [WakeMission]) throws { self.missions = missions }
}

/// The wake settings and plain alarms of a preview, in memory.
final class PreviewSleepAlarmStore: SleepAlarmStore, @unchecked Sendable {

    private var settings: SleepWakeSettings
    private var scheduled: [String: UUID] = [:]

    init(settings: SleepWakeSettings) {
        self.settings = settings
    }

    func load() throws -> SleepWakeSettings { settings }

    func save(_ settings: SleepWakeSettings) throws { self.settings = settings }

    func loadScheduled() throws -> [String: UUID] { scheduled }

    func saveScheduled(_ scheduled: [String: UUID]) throws { self.scheduled = scheduled }
}

/// A sleep plan without alarms, for a preview.
@MainActor
final class PreviewSleepAlarmSource: SleepAlarmSource {

    func sleepAlarms(today: String) async -> [SleepAlarmTime]? { [] }

    func asksForSleepAlarms(_ payload: [String: String]) -> Bool { false }
}

// MARK: - Preview
extension WakeGuard {

    /// A guard for a preview, over the preview scheduler and an empty store.
    static func preview() -> WakeGuard {
        WakeGuard(scheduler: PreviewAlarmScheduler(), store: PreviewMissionStore())
    }
}
