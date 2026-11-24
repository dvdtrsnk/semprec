import Combine
import CoreKit
import Foundation
import UserNotifications

/// The notifications of the process: the permission, this device's push registration, the reminders it schedules
/// itself, the number on its icon and the notification the person tapped, which the first signed-in scene opens. What
/// each step reads and where a tap leads is decided by the shared `DeviceNotificationService`; this class only carries
/// it to the system.
@MainActor
final class AppNotifications {

    // MARK: - Shared
    /// The one instance of the process: the app delegate hands it what the system delivers, and every scene's
    /// composition reaches it.
    static let shared: AppNotifications = {
        let service = SharedDeviceNotifications()
        let notifications = AppNotifications(
            service: service,
            center: SystemNotificationCenter(),
            environment: AppNotifications.buildEnvironment()
        )
        notifications.sleepAlarms = SleepAlarmClock(
            source: service,
            scheduler: SystemAlarmScheduler(),
            wakeGuard: .shared,
            store: DefaultsSleepAlarmStore()
        )
        return notifications
    }()

    /// The prefix of the identifiers of the reminders this class schedules, so a new read replaces only them.
    static let reminderPrefix = "reminder."

    // MARK: - Dependencies
    private let service: any DeviceNotificationService
    private let center: any LocalNotificationCenter
    private let environment: PushEnvironment
    private let now: @MainActor () -> Date
    /// Asks APNs for this device's token, which arrives through `didRegister(deviceToken:)`. Nil where the app
    /// registers for no remote notifications (macOS).
    var registerForRemoteNotifications: (@MainActor () -> Void)?
    /// Rings the sleep plan's alarms; nil where the process rings none (tests).
    var sleepAlarms: SleepAlarmClock?
    /// The system's notification center holds its delegate weakly.
    private var centerDelegate: NotificationCenterDelegate?

    // MARK: - State
    /// Where the last tapped notification leads, until a scene takes it.
    private(set) var pendingTarget: NotificationTarget?
    /// Sends when a tapped notification's target waits, and once to each new subscriber, which then takes it.
    let targetArrivals = CurrentValueSubject<Void, Never>(())

    // MARK: - Init
    init(
        service: any DeviceNotificationService,
        center: any LocalNotificationCenter,
        environment: PushEnvironment,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.service = service
        self.center = center
        self.environment = environment
        self.now = now
    }

    // MARK: - Methods
    /// Makes this instance the receiver of the notifications the person taps; the system calls it from then on.
    func start() {
        let delegate = NotificationCenterDelegate { [weak self] payload in self?.didOpen(payload) }
        centerDelegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
    }

    /// Asks for the permission to notify (the system asks the person only once) and, once allowed, registers this
    /// device and schedules its reminders.
    func requestPermission() async {
        guard await center.requestAuthorization() else { return }
        await refresh()
    }

    /// Someone is signed in: rings the sleep plan's alarms and, when notifications are allowed, registers this device,
    /// schedules its reminders and sets the icon's number. Asks the person nothing about notifications.
    func refresh() async {
        await sleepAlarms?.sync()
        guard await center.isAuthorized() else { return }
        registerForRemoteNotifications?()
        await resyncReminders()
        await updateBadge()
    }

    /// Nobody is signed in: the sleep alarms, the reminders and the number of the person who was are removed.
    func signedOut() async {
        await sleepAlarms?.signedOut()
        center.removePending(await scheduledReminders())
        await center.setBadge(0)
    }

    /// APNs issued `deviceToken` for this device.
    func didRegister(deviceToken: Data) async {
        _ = await service.register(deviceToken: deviceToken, environment: environment)
    }

    /// A silent push arrived: a sleep resync rings the plan's alarms again, a reminders resync reads the reminders
    /// again. Answers whether it brought new data.
    func didReceiveRemoteNotification(_ payload: [String: String]) async -> Bool {
        if let sleepAlarms, sleepAlarms.asksForSleepAlarms(payload) {
            await sleepAlarms.sync()
            return true
        }
        guard service.asksForReminders(payload) else { return false }
        return await resyncReminders()
    }

    /// The person tapped a notification with `payload`.
    func didOpen(_ payload: [String: String]) {
        guard let target = service.target(of: payload) else { return }
        pendingTarget = target
        targetArrivals.send(())
    }

    /// Hands the tapped notification's target to one scene; the next scene that asks gets nil.
    func takeTarget() -> NotificationTarget? {
        defer { pendingTarget = nil }
        return pendingTarget
    }
}

// MARK: - Build
extension AppNotifications {

    /// Debug builds get their tokens from the APNs sandbox, Release builds from production, as the build's Info.plist
    /// says under `SemprecApnsEnvironment`.
    nonisolated static func buildEnvironment(bundle: Bundle = .main) -> PushEnvironment {
        let value = bundle.object(forInfoDictionaryKey: "SemprecApnsEnvironment") as? String
        return value.flatMap(PushEnvironment.init(rawValue:)) ?? .production
    }
}

// MARK: - Private
private extension AppNotifications {

    /// Replaces the scheduled reminders with the ones read now; keeps them when the read failed.
    @discardableResult
    func resyncReminders() async -> Bool {
        let start = now()
        guard let reminders = await service.reminders(from: start) else { return false }
        center.removePending(await scheduledReminders())
        for reminder in reminders where reminder.fireAt > start {
            await center.schedule(notification(for: reminder))
        }
        return true
    }

    func updateBadge() async {
        guard let badge = await service.badge() else { return }
        await center.setBadge(badge)
    }

    func scheduledReminders() async -> [String] {
        await center.pendingIdentifiers().filter { $0.hasPrefix(Self.reminderPrefix) }
    }

    func notification(for reminder: DeviceReminder) -> LocalNotification {
        let key: String.LocalizationValue = switch reminder.kind {
        case .event: "reminder.event.body"
        case .task: "reminder.task.body"
        }
        let sameDay = Calendar.current.isDate(reminder.startsAt, inSameDayAs: reminder.fireAt)
        let time = reminder.startsAt.formatted(date: sameDay ? .omitted : .abbreviated, time: .shortened)
        return LocalNotification(
            identifier: Self.reminderPrefix + reminder.identifier,
            title: reminder.title,
            body: String(format: String(localized: key), locale: .current, time),
            userInfo: service.userInfo(of: reminder),
            date: reminder.fireAt
        )
    }
}
