import Foundation

/// The APNs environment a device token belongs to: the sandbox for a development build, production for a distributed
/// one. The raw value is what the app's Info.plist names under `SemprecApnsEnvironment`.
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

/// Where a tapped notification leads.
public enum NotificationTarget: Equatable, Sendable {

    case event(id: String)
    case task(id: String)
    case invitations
}
