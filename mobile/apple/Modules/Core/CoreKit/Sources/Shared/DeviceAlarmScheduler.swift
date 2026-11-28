#if os(iOS)
import AlarmKit
import SwiftUI
#endif
import Foundation
@preconcurrency internal import SharedSDK

/// The shared layer's `DeviceAlarms` on the system's alarms: AlarmKit on iOS and iPadOS, which rings through silent
/// mode and a Focus; macOS has no AlarmKit, so it reports that it is unsupported and holds nothing. It decides
/// nothing: which alarms ring is the Kotlin `SleepAlarmSync`. An alarm has no countdown, so it needs no Live Activity
/// and the app no widget extension; a wake mission's alert has a second button, `OpenWakeGuardIntent`, that opens the
/// app. Every call comes on the main thread, and so does every callback.
@MainActor
final class DeviceAlarmScheduler: NSObject {}

// MARK: - Protocol conformance
extension DeviceAlarmScheduler: @preconcurrency SharedSDK.DeviceAlarms {

    func authorization() -> SharedSDK.DeviceAlarmAuthorization {
        Self.systemAuthorization()
    }

    func requestAuthorization(callback: @escaping (SharedSDK.DeviceAlarmAuthorization) -> Void) {
        // Like scheduling, the one system call is awaited in a task that holds no state of this object and ends with
        // its answer, which it hands over exactly once.
        Task { @MainActor in callback(await Self.systemRequestAuthorization()) }
    }

    func schedule(
        ringAtEpochSeconds: Int64,
        opensWakeGuard: Bool,
        callback: @escaping (SharedSDK.DeviceAlarmScheduling) -> Void
    ) {
        // AlarmKit schedules asynchronously and the port answers by callback, so the one system call is awaited in a
        // task that holds no state of this object and ends with its answer, which it hands over exactly once.
        let date = Date(timeIntervalSince1970: TimeInterval(ringAtEpochSeconds))
        Task { @MainActor in callback(await Self.systemSchedule(at: date, opensWakeGuard: opensWakeGuard)) }
    }

    func cancel(id: String) -> Bool {
        Self.systemCancel(id: id)
    }

    func held(callback: @escaping ([SharedSDK.HeldDeviceAlarm]?) -> Void) {
        callback(Self.systemHeld())
    }
}

#if os(iOS)
/// The metadata of this app's alarms. They carry none; AlarmKit requires the type to exist.
struct AlldotsAlarmMetadata: AlarmMetadata {}

/// How the system removes an alarm: one that rings is stopped, any other is cancelled.
enum AlarmRemoval: Equatable {

    case stop
    case cancel
}

// MARK: - Mapping
// Pure functions between AlarmKit's values and the shared ones, internal so that CoreKitTests check every branch.
extension DeviceAlarmScheduler {

    static func authorization(_ state: AlarmManager.AuthorizationState) -> SharedSDK.DeviceAlarmAuthorization {
        switch state {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized: .authorized
        @unknown default: .denied
        }
    }

    static func phase(_ state: Alarm.State) -> SharedSDK.DeviceAlarmPhase {
        switch state {
        case .scheduled, .countdown, .paused: .scheduled
        case .alerting: .alerting
        // A state this build does not know is never taken for one that may be removed.
        @unknown default: .alerting
        }
    }

    static func removal(_ state: Alarm.State) -> AlarmRemoval {
        state == .alerting ? .stop : .cancel
    }

    /// What the device answers when AlarmKit refuses to schedule: a limit is something the app can tell the person,
    /// anything else is not explained.
    static func failure(_ error: any Error) -> SharedSDK.DeviceAlarmScheduling {
        if case AlarmManager.AlarmError.maximumLimitReached = error {
            return SharedSDK.DeviceAlarmSchedulingRefused(failure: .limitReached)
        }
        return SharedSDK.DeviceAlarmSchedulingFailed.shared
    }

    /// The system draws the alert in another process, which does not look strings up in this module's catalog, so the
    /// text is resolved here and handed over as finished text.
    static func finished(_ key: String.LocalizationValue) -> LocalizedStringResource {
        LocalizedStringResource(stringLiteral: String(localized: key, bundle: .module))
    }

    static func alert(opensWakeGuard: Bool) -> AlarmPresentation.Alert {
        let title = finished("alarm.sleep.title")
        let scan: AlarmButton? = opensWakeGuard ? scanButton : nil
        let behavior: AlarmPresentation.Alert.SecondaryButtonBehavior? = opensWakeGuard ? .custom : nil
        if #available(iOS 26.1, *) {
            return AlarmPresentation.Alert(title: title, secondaryButton: scan, secondaryButtonBehavior: behavior)
        }
        let stop = AlarmButton(text: finished("alarm.stop"), textColor: .white, systemImageName: "stop.circle")
        return AlarmPresentation.Alert(
            title: title,
            stopButton: stop,
            secondaryButton: scan,
            secondaryButtonBehavior: behavior
        )
    }

    static var scanButton: AlarmButton {
        AlarmButton(text: finished("alarm.scan"), textColor: .white, systemImageName: "qrcode.viewfinder")
    }
}

// MARK: - AlarmKit
private extension DeviceAlarmScheduler {

    static func systemAuthorization() -> SharedSDK.DeviceAlarmAuthorization {
        authorization(AlarmManager.shared.authorizationState)
    }

    /// Asks the person when never asked; an answer given before is read back. A request the system fails is answered
    /// with what the device holds, which the caller shows as it is.
    static func systemRequestAuthorization() async -> SharedSDK.DeviceAlarmAuthorization {
        do {
            return authorization(try await AlarmManager.shared.requestAuthorization())
        } catch {
            return systemAuthorization()
        }
    }

    static func systemSchedule(at date: Date, opensWakeGuard: Bool) async -> SharedSDK.DeviceAlarmScheduling {
        // An undecided permission is asked for by the system as part of scheduling; a refused one is not asked again.
        guard AlarmManager.shared.authorizationState != .denied else {
            return SharedSDK.DeviceAlarmSchedulingRefused(failure: .notAuthorized)
        }
        let configuration = AlarmManager.AlarmConfiguration<AlldotsAlarmMetadata>.alarm(
            schedule: .fixed(date),
            attributes: AlarmAttributes(
                presentation: AlarmPresentation(alert: alert(opensWakeGuard: opensWakeGuard)),
                tintColor: .accentColor
            ),
            secondaryIntent: opensWakeGuard ? OpenWakeGuardIntent() : nil
        )
        do {
            let alarm = try await AlarmManager.shared.schedule(id: UUID(), configuration: configuration)
            return SharedSDK.DeviceAlarmSchedulingScheduled(id: alarm.id.uuidString)
        } catch {
            return failure(error)
        }
    }

    static func systemCancel(id: String) -> Bool {
        guard let identifier = UUID(uuidString: id) else { return false }
        do {
            // An alarm that is gone, because it rang or was stopped meanwhile, needs no removing.
            guard let alarm = try AlarmManager.shared.alarms.first(where: { $0.id == identifier }) else { return true }
            switch removal(alarm.state) {
            case .stop: try AlarmManager.shared.stop(id: identifier)
            case .cancel: try AlarmManager.shared.cancel(id: identifier)
            }
            return true
        } catch {
            return false
        }
    }

    static func systemHeld() -> [SharedSDK.HeldDeviceAlarm]? {
        do {
            return try AlarmManager.shared.alarms.map {
                SharedSDK.HeldDeviceAlarm(id: $0.id.uuidString, phase: phase($0.state))
            }
        } catch {
            return nil
        }
    }
}
#else
// MARK: - Unsupported
private extension DeviceAlarmScheduler {

    static func systemAuthorization() -> SharedSDK.DeviceAlarmAuthorization { .unsupported }

    static func systemRequestAuthorization() async -> SharedSDK.DeviceAlarmAuthorization { .unsupported }

    static func systemSchedule(at date: Date, opensWakeGuard: Bool) async -> SharedSDK.DeviceAlarmScheduling {
        SharedSDK.DeviceAlarmSchedulingRefused(failure: .unsupported)
    }

    static func systemCancel(id: String) -> Bool { true }

    static func systemHeld() -> [SharedSDK.HeldDeviceAlarm]? { [] }
}
#endif
