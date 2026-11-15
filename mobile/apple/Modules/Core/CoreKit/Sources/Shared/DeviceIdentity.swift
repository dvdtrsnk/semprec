import Foundation
@preconcurrency internal import SharedSDK

/// What this installation tells the server about itself at sign-in.
enum DeviceIdentity {

    private static let deviceIdKey = "cz.semprec.deviceId"

    static func current(defaults: UserDefaults = .standard, bundle: Bundle = .main) -> SharedSDK.DeviceInfo {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let appVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return SharedSDK.DeviceInfo(
            platform: platform,
            deviceId: deviceId(in: defaults),
            deviceName: String(ProcessInfo.processInfo.hostName.prefix(100)),
            deviceKind: deviceKind,
            osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            appVersion: appVersion
        )
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
    #else
    private static let platform = SharedSDK.AppPlatform.ios
    private static var deviceKind: String {
        let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? hardwareModel()
        return model.hasPrefix("iPad") ? "ipad" : "iphone"
    }

    private static func hardwareModel() -> String {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var bytes = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.machine", &bytes, &size, nil, 0)
        return String(cString: bytes)
    }
    #endif
}
