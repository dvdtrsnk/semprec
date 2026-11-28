import Foundation

/// The APNs environment a device token belongs to: the sandbox for a development build, production for a distributed
/// one. The raw value is what the app's Info.plist names under `AlldotsApnsEnvironment`.
public enum PushEnvironment: String, Equatable, Sendable {

    case sandbox
    case production
}

public enum DeviceReminderKind: Equatable, Sendable {

    case event
    case task
}

/// A reminder the device shows itself. `identifier` names its local notification and is the same for the same reminder
/// on every read.
public struct DeviceReminder: Equatable, Sendable {

    public let identifier: String
    public let kind: DeviceReminderKind
    public let itemId: String
    public let title: String
    public let fireAt: Date
    public let startsAt: Date

    public init(
        identifier: String,
        kind: DeviceReminderKind,
        itemId: String,
        title: String,
        fireAt: Date,
        startsAt: Date
    ) {
        self.identifier = identifier
        self.kind = kind
        self.itemId = itemId
        self.title = title
        self.fireAt = fireAt
        self.startsAt = startsAt
    }
}

/// What a silent push asks the device to read again.
public enum DeviceResync: Equatable, Sendable {

    case reminders
    case sleepAlarms
}

/// How far one run of the sleep alarms got, as the shared layer reports it.
public enum SleepAlarmSyncResult: Equatable, Sendable {

    /// The device holds the alarms the sleep plan asks for.
    case synced
    /// The device has no alarms to ring; nothing was done.
    case unsupported
    /// The sleep plan could not be read, so the alarms the device holds stay.
    case readFailed
    /// The person has not allowed the app to ring alarms.
    case notAuthorized
    /// The device holds as many alarms as it lets the app hold.
    case limitReached
    /// The device could not list, remove or ring an alarm for a reason the app cannot explain.
    case deviceFailed
}

/// Where a tapped notification leads.
public enum NotificationTarget: Equatable, Sendable {

    case event(id: String)
    case task(id: String)
    case invitations
}
