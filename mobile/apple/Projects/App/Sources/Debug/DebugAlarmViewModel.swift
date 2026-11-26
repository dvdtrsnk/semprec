import Combine
import Foundation

/// The debug screen of system alarms: the permission, this app's alarms, and scheduling or cancelling one. It drives
/// the platform's alarms directly, without a shared ViewModel, because it tests a platform API and decides nothing of
/// the person's data (docs/adr/2026-11-24-apple-app-rings-system-alarms-through-alarmkit.md).
@MainActor
final class DebugAlarmViewModel: ObservableObject {

    // MARK: - Dependencies
    private let scheduler: any AlarmScheduler
    /// Schedules the alarms that only a code ends; nil where the screen offers none.
    private let wakeGuard: WakeGuard?
    private let now: @MainActor () -> Date

    // MARK: - Published Properties
    @Published private(set) var authorization: AlarmAuthorization
    /// This app's alarms, the soonest first; daily ones after the ones that ring once.
    @Published private(set) var alarms: [ScheduledAlarm] = []
    @Published private(set) var failure: DebugAlarmFailure?
    @Published private(set) var isScheduling = false

    // MARK: - Init
    init(
        scheduler: any AlarmScheduler,
        wakeGuard: WakeGuard? = nil,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.scheduler = scheduler
        self.wakeGuard = wakeGuard
        self.now = now
        authorization = scheduler.authorization()
    }

    // MARK: - Methods
    /// Reads the alarms, then follows every change of them until the screen's task is cancelled.
    func observe() async {
        reload()
        for await alarms in scheduler.updates() {
            self.alarms = Self.ordered(alarms)
            authorization = scheduler.authorization()
        }
    }

    func requestAuthorization() async {
        do {
            authorization = try await scheduler.requestAuthorization()
        } catch {
            failure = .unexpected(String(describing: error))
        }
    }

    /// Schedules one alarm; a blank `title` becomes the default title. With `codes`, it is a wake-up mission that
    /// rings until one of them is scanned.
    func schedule(title: String, time: AlarmTime, codes: [String] = []) async {
        guard !isScheduling else { return }
        isScheduling = true
        defer { isScheduling = false }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmed.isEmpty ? Self.defaultTitle : trimmed
        do {
            if let wakeGuard, !WakeCodes.normalized(codes).isEmpty {
                try await wakeGuard.create(title: title, time: time, codes: codes)
            } else {
                try await scheduler.schedule(AlarmRequest(title: title, schedule: time))
            }
        } catch let error as AlarmSchedulingError {
            failure = DebugAlarmFailure(error)
        } catch {
            failure = .unexpected(String(describing: error))
        }
        authorization = scheduler.authorization()
        reload()
    }

    /// Schedules one alarm `seconds` from now, for a quick test with the phone locked.
    func schedule(title: String, in seconds: TimeInterval, codes: [String] = []) async {
        await schedule(title: title, time: .once(now().addingTimeInterval(seconds)), codes: codes)
    }

    /// Removes a wake-up mission that is not ringing, with its alarms.
    func removeMission(_ id: UUID) async {
        await wakeGuard?.remove(id)
        reload()
    }

    func cancel(_ id: UUID) {
        do {
            try scheduler.cancel(id: id)
        } catch {
            failure = .unexpected(String(describing: error))
        }
        reload()
    }

    /// Cancels every alarm of this app; a refusal stops at the first alarm the system did not cancel.
    func cancelAll() {
        do {
            for alarm in alarms {
                try scheduler.cancel(id: alarm.id)
            }
        } catch {
            failure = .unexpected(String(describing: error))
        }
        reload()
    }

    func dismissFailure() {
        failure = nil
    }
}

/// What went wrong on the debug screen of alarms.
enum DebugAlarmFailure: Equatable {

    case notAuthorized
    case limitReached
    case unsupported
    /// Any other refusal, with the system's own description.
    case unexpected(String)

    init(_ error: AlarmSchedulingError) {
        switch error {
        case .notAuthorized: self = .notAuthorized
        case .limitReached: self = .limitReached
        case .unsupported: self = .unsupported
        }
    }
}

// MARK: - Private
private extension DebugAlarmViewModel {

    static var defaultTitle: String { String(localized: "debug.alarm.defaultTitle") }

    func reload() {
        do {
            alarms = Self.ordered(try scheduler.alarms())
        } catch {
            failure = .unexpected(String(describing: error))
        }
    }

    static func ordered(_ alarms: [ScheduledAlarm]) -> [ScheduledAlarm] {
        alarms.sorted { sortKey($0) < sortKey($1) }
    }

    /// Alarms that ring once by their date, then daily ones by their time, then alarms without a schedule.
    static func sortKey(_ alarm: ScheduledAlarm) -> (Int, Double) {
        switch alarm.time {
        case .once(let date): (0, date.timeIntervalSinceReferenceDate)
        case .daily(let hour, let minute): (1, Double(hour * 60 + minute))
        case nil: (2, 0)
        }
    }
}
