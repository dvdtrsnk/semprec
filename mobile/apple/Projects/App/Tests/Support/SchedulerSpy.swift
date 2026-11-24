import Foundation

@testable import Semprec

struct ScriptedAlarmFailure: Error, CustomStringConvertible {

    var description: String { "scripted failure" }
}

/// A scheduler that holds its alarms in memory and fails where a test scripts it to.
final class SchedulerSpy: AlarmScheduler, @unchecked Sendable {

    var authorizationState: AlarmAuthorization
    var grantedAuthorization: AlarmAuthorization?
    var authorizationAfterSchedule: AlarmAuthorization?
    var requestFailure: Error?
    var scheduleFailure: Error?
    var readFailure: Error?
    var cancelFailure: Error?
    var held: [ScheduledAlarm] = []
    var updateBatches: [[ScheduledAlarm]] = []
    private(set) var requests: [AlarmRequest] = []
    private(set) var cancelled: [UUID] = []
    private(set) var stopped: [UUID] = []
    /// The system refuses every request after this many accepted ones.
    var limit: Int?
    private(set) var authorizationRequests = 0

    init(authorization: AlarmAuthorization) {
        authorizationState = authorization
    }

    var isSupported: Bool { authorizationState != .unsupported }

    func authorization() -> AlarmAuthorization { authorizationState }

    func requestAuthorization() async throws -> AlarmAuthorization {
        authorizationRequests += 1
        if let requestFailure { throw requestFailure }
        authorizationState = grantedAuthorization ?? authorizationState
        return authorizationState
    }

    func alarms() throws -> [ScheduledAlarm] {
        if let readFailure { throw readFailure }
        return held
    }

    func schedule(_ request: AlarmRequest) async throws -> ScheduledAlarm {
        // Lets another task run, as the system's scheduling does.
        await Task.yield()
        requests.append(request)
        if let authorizationAfterSchedule { authorizationState = authorizationAfterSchedule }
        if let scheduleFailure { throw scheduleFailure }
        if let limit, held.count >= limit { throw AlarmSchedulingError.limitReached }
        let alarm = ScheduledAlarm(id: request.id, time: request.schedule, phase: .scheduled)
        held.append(alarm)
        return alarm
    }

    func cancel(id: UUID) throws {
        if let cancelFailure { throw cancelFailure }
        cancelled.append(id)
        held.removeAll { $0.id == id }
    }

    func stop(id: UUID) throws {
        stopped.append(id)
        held.removeAll { $0.id == id }
    }

    /// Marks the held alarm `id` as ringing.
    func ring(_ id: UUID) {
        held = held.map { $0.id == id ? ScheduledAlarm(id: $0.id, time: $0.time, phase: .alerting) : $0 }
    }

    func updates() -> AsyncStream<[ScheduledAlarm]> {
        let batches = updateBatches
        return AsyncStream { continuation in
            for batch in batches { continuation.yield(batch) }
            continuation.finish()
        }
    }
}
