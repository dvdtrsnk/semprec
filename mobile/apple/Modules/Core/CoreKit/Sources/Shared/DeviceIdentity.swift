import Foundation
@preconcurrency internal import SharedSDK

/// What this installation tells the server about itself at sign-in.
enum DeviceIdentity {

    private static let deviceIdKey = "cz.semprec.deviceId"
    private static let maxNameLength = 100

    /// Reads the kernel's string value `name` (`sysctlbyname`); nothing here touches the network.
    private static func sysctlString(_ name: String) -> String {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else { return "" }
        return String(cString: bytes)
    }

    static func current(defaults: UserDefaults = .standard, bundle: Bundle = .main) -> SharedSDK.DeviceInfo {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let appVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return SharedSDK.DeviceInfo(
            platform: platform,
            deviceId: deviceId(in: defaults),
            deviceName: deviceName(),
            deviceKind: deviceKind,
            osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            appVersion: appVersion
        )
    }

    /// The name the server shows in the list of sessions: at most `maxNameLength` characters, never empty. It is read
    /// from the kernel and never from `ProcessInfo.hostName`, which resolves the host name over the network and can
    /// block for tens of seconds, so that the app would show a blank screen while it starts.
    static func deviceName() -> String {
        let name = String(platformName().trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxNameLength))
        return name.isEmpty ? fallbackName : name
    }

    /// A random identifier created once per installation; it distinguishes this device in the list of sessions.
    private static func deviceId(in defaults: UserDefaults) -> String {
        if let stored = defaults.string(forKey: deviceIdKey), UUID(uuidString: stored) != nil { return stored }
        let created = UUID().uuidString.lowercased()
        defaults.set(created, forKey: deviceIdKey)
        return created
    }

    // The one place CoreKit tells the platforms apart: the server accepts different device kinds for each.
    #if os(macOS)
    private static let platform = SharedSDK.AppPlatform.macos
    private static let deviceKind = "mac"
    private static let fallbackName = "Mac"

    /// The computer's local host name, as the kernel knows it.
    private static func platformName() -> String {
        sysctlString("kern.hostname")
    }
    #else
    private static let platform = SharedSDK.AppPlatform.ios
    private static let fallbackName = "iPhone"

    /// iOS reports no useful host name (`kern.hostname` is "localhost"), so the name is the kind of device with its
    /// model identifier, for example "iPhone (iPhone17,1)".
    private static func platformName() -> String {
        let model = hardwareModel()
        let kind = deviceKind == "ipad" ? "iPad" : "iPhone"
        return model.isEmpty ? kind : "\(kind) (\(model))"
    }

    private static var deviceKind: String {
        hardwareModel().hasPrefix("iPad") ? "ipad" : "iphone"
    }

    private static func hardwareModel() -> String {
        ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? sysctlString("hw.machine")
    }
    #endif
}
