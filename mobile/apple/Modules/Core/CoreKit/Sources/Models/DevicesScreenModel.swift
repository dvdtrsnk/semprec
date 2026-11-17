import Foundation

/// The platform a signed-in device runs on, as the server records it.
public enum AccountPlatform: Equatable, Sendable {

    case web
    case ios
    case macos
    case unknown
}

/// What kind of device a session belongs to.
public enum AccountDeviceKind: Equatable, Sendable {

    case iphone
    case ipad
    case mac
    case browser
    case unknown
}

public enum DevicesPhase: Equatable, Sendable {

    case loading
    case content
    case error
}

/// One signed-in device; `createdAt` and `lastSeenAt` are the server's instants (ISO 8601).
public struct DeviceItem: Equatable, Sendable, Identifiable {

    public let id: String
    public let kind: AccountDeviceKind
    public let platform: AccountPlatform
    public let name: String?
    public let createdAt: String
    public let lastSeenAt: String

    public init(
        id: String,
        kind: AccountDeviceKind,
        platform: AccountPlatform,
        name: String?,
        createdAt: String,
        lastSeenAt: String
    ) {
        self.id = id
        self.kind = kind
        self.platform = platform
        self.name = name
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
    }
}

/// What the person is asked to confirm before a device is signed out.
public enum DevicesConfirm: Equatable, Sendable {

    case one(DeviceItem)
    case others
}

public struct DevicesState: Equatable, Sendable {

    public var phase: DevicesPhase
    public var failure: FailureKind?
    public var current: DeviceItem?
    public var others: [DeviceItem]
    public var confirm: DevicesConfirm?
    public var working: Bool
    public var writeFailure: Failed?

    public init(
        phase: DevicesPhase = .loading,
        failure: FailureKind? = nil,
        current: DeviceItem? = nil,
        others: [DeviceItem] = [],
        confirm: DevicesConfirm? = nil,
        working: Bool = false,
        writeFailure: Failed? = nil
    ) {
        self.phase = phase
        self.failure = failure
        self.current = current
        self.others = others
        self.confirm = confirm
        self.working = working
        self.writeFailure = writeFailure
    }
}

public enum DevicesAction: Equatable, Sendable {

    case retry
    case ask(deviceId: String)
    case askOthers
    case cancel
    case confirm
    case dismissFailure
}

/// The devices screen has no effects: signing out is a state change.
public typealias DevicesScreenModel = ScreenModel<DevicesState, DevicesAction, Never>

/// Devices screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedDevicesScreenModel = ScriptedScreenModel<DevicesState, DevicesAction, Never>
