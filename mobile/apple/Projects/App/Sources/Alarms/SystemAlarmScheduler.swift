#if os(iOS)
import AlarmKit
import AppIntents
#endif
import Foundation
import SwiftUI

/// The `AlarmScheduler` of the system: AlarmKit on iOS and iPadOS, nothing on macOS, which has no AlarmKit. An alarm
/// has no countdown, so it needs no Live Activity and the app no widget extension. The system's Stop button always
/// silences the alert; a wake-up alarm adds a second button that opens the app on the wake-up guard.
struct SystemAlarmScheduler: AlarmScheduler {

    // MARK: - Protocol conformance
    #if os(iOS)
    var isSupported: Bool { true }

    func authorization() -> AlarmAuthorization {
        Self.authorization(AlarmManager.shared.authorizationState)
    }

    func requestAuthorization() async throws -> AlarmAuthorization {
        Self.authorization(try await AlarmManager.shared.requestAuthorization())
    }

    func alarms() throws -> [ScheduledAlarm] {
        try AlarmManager.shared.alarms.map(Self.alarm)
    }

    func schedule(_ request: AlarmRequest) async throws -> ScheduledAlarm {
        // An undecided permission is asked for by the system as part of scheduling; a refused one is not asked again.
        guard AlarmManager.shared.authorizationState != .denied else { throw AlarmSchedulingError.notAuthorized }
        let configuration = AlarmManager.AlarmConfiguration<SemprecAlarmMetadata>.alarm(
            schedule: Self.schedule(request.schedule),
            attributes: AlarmAttributes(
                presentation: AlarmPresentation(alert: Self.alert(request)),
                tintColor: .accentColor
            ),
            secondaryIntent: request.opensWakeGuard ? OpenWakeGuardIntent() : nil
        )
        do {
            return Self.alarm(try await AlarmManager.shared.schedule(id: request.id, configuration: configuration))
        } catch AlarmManager.AlarmError.maximumLimitReached {
            throw AlarmSchedulingError.limitReached
        }
    }

    func cancel(id: UUID) throws {
        try AlarmManager.shared.cancel(id: id)
    }

    func stop(id: UUID) throws {
        try AlarmManager.shared.stop(id: id)
    }

    func updates() -> AsyncStream<[ScheduledAlarm]> {
        AsyncStream { continuation in
            let task = Task {
                for await alarms in AlarmManager.shared.alarmUpdates {
                    continuation.yield(alarms.map(Self.alarm))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    #else
    var isSupported: Bool { false }

    func authorization() -> AlarmAuthorization { .unsupported }

    func requestAuthorization() async throws -> AlarmAuthorization { .unsupported }

    func alarms() throws -> [ScheduledAlarm] { [] }

    func schedule(_ request: AlarmRequest) async throws -> ScheduledAlarm {
        throw AlarmSchedulingError.unsupported
    }

    func cancel(id: UUID) throws {
        throw AlarmSchedulingError.unsupported
    }

    func stop(id: UUID) throws {
        throw AlarmSchedulingError.unsupported
    }

    func updates() -> AsyncStream<[ScheduledAlarm]> {
        AsyncStream { $0.finish() }
    }
    #endif
}

#if os(iOS)
/// The metadata of this app's alarms. They carry none yet; AlarmKit requires the type to exist.
struct SemprecAlarmMetadata: AlarmMetadata {}

/// The alert's second button of a wake-up alarm: opens the app, where the wake-up guard asks for the code.
struct OpenWakeGuardIntent: LiveActivityIntent {

    static let title: LocalizedStringResource = "alarm.scan"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

// MARK: - Private
private extension SystemAlarmScheduler {

    static let everyDay: [Locale.Weekday] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]

    static func authorization(_ state: AlarmManager.AuthorizationState) -> AlarmAuthorization {
        switch state {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized: .authorized
        @unknown default: .notDetermined
        }
    }

    static func schedule(_ time: AlarmTime) -> Alarm.Schedule {
        switch time {
        case .once(let date):
            .fixed(date)
        case .daily(let hour, let minute):
            .relative(Alarm.Schedule.Relative(
                time: Alarm.Schedule.Relative.Time(hour: hour, minute: minute),
                repeats: .weekly(Self.everyDay)
            ))
        }
    }

    static func alarm(_ alarm: Alarm) -> ScheduledAlarm {
        ScheduledAlarm(id: alarm.id, time: alarm.schedule.flatMap(time), phase: phase(alarm.state))
    }

    static func time(_ schedule: Alarm.Schedule) -> AlarmTime? {
        switch schedule {
        case .fixed(let date): .once(date)
        case .relative(let relative) where isEveryDay(relative.repeats):
            .daily(hour: relative.time.hour, minute: relative.time.minute)
        case .relative: nil
        @unknown default: nil
        }
    }

    /// The system may list the days in its own order, so they are compared as a set.
    static func isEveryDay(_ recurrence: Alarm.Schedule.Relative.Recurrence) -> Bool {
        guard case .weekly(let days) = recurrence else { return false }
        return Set(days) == Set(Self.everyDay)
    }

    static func phase(_ state: Alarm.State) -> AlarmPhase {
        switch state {
        case .scheduled: .scheduled
        case .countdown: .countdown
        case .paused: .paused
        case .alerting: .alerting
        @unknown default: .scheduled
        }
    }

    /// The system draws the alert in another process, which does not look strings up in this app's catalog, so every
    /// text is resolved here and handed over as finished text.
    static func finished(_ text: String) -> LocalizedStringResource {
        LocalizedStringResource(stringLiteral: text)
    }

    static func alert(_ request: AlarmRequest) -> AlarmPresentation.Alert {
        let title = finished(request.title)
        let scan: AlarmButton? = request.opensWakeGuard ? scanButton : nil
        let behavior: AlarmPresentation.Alert.SecondaryButtonBehavior? = request.opensWakeGuard ? .custom : nil
        if #available(iOS 26.1, *) {
            return AlarmPresentation.Alert(title: title, secondaryButton: scan, secondaryButtonBehavior: behavior)
        }
        let stop = AlarmButton(
            text: finished(String(localized: "alarm.stop")),
            textColor: .white,
            systemImageName: "stop.circle"
        )
        return AlarmPresentation.Alert(
            title: title,
            stopButton: stop,
            secondaryButton: scan,
            secondaryButtonBehavior: behavior
        )
    }

    static var scanButton: AlarmButton {
        AlarmButton(
            text: finished(String(localized: "alarm.scan")),
            textColor: .white,
            systemImageName: "qrcode.viewfinder"
        )
    }
}
#endif
