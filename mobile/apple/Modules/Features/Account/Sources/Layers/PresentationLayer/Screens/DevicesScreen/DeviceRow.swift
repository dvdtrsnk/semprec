import CoreKit
import DesignSystem
import SwiftUI

/// One signed-in device: its symbol, its name, where it runs and when it was last used and first signed in.
struct DeviceRow: View {

    // MARK: - Dependencies
    let device: DeviceItem
    let isCurrent: Bool

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.medium) {
            Image(systemName: Self.symbol(of: device.kind))
                .font(.title3)
                .foregroundStyle(Theme.Colors.secondaryText)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.name(of: device)).font(.body)
                Text(subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                if !isCurrent, let since = AccountFormat.day(device.createdAt) {
                    Text(String(format: String(localized: "devices.since", bundle: .module), since))
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
    }
}

// MARK: - Words
extension DeviceRow {

    /// The device's own name, or the name of its kind when it has none.
    static func name(of device: DeviceItem) -> String {
        if let name = device.name { return name }
        switch device.kind {
        case .iphone: return String(localized: "devices.kind.iphone", bundle: .module)
        case .ipad: return String(localized: "devices.kind.ipad", bundle: .module)
        case .mac: return String(localized: "devices.kind.mac", bundle: .module)
        case .browser: return String(localized: "devices.kind.browser", bundle: .module)
        case .unknown: return String(localized: "devices.kind.unknown", bundle: .module)
        }
    }

    static func symbol(of kind: AccountDeviceKind) -> String {
        switch kind {
        case .iphone: "iphone"
        case .ipad: "ipad"
        case .mac: "laptopcomputer"
        case .browser: "globe"
        case .unknown: "questionmark.circle"
        }
    }

    static func platformName(_ platform: AccountPlatform) -> String {
        switch platform {
        case .web: String(localized: "devices.platform.web", bundle: .module)
        case .ios: String(localized: "devices.platform.ios", bundle: .module)
        case .macos: String(localized: "devices.platform.macos", bundle: .module)
        case .unknown: String(localized: "devices.platform.unknown", bundle: .module)
        }
    }
}

// MARK: - Subviews
private extension DeviceRow {

    var subtitle: String {
        let platform = Self.platformName(device.platform)
        if isCurrent { return platform + " · " + String(localized: "devices.activeNow", bundle: .module) }
        let seen = AccountFormat.relative(device.lastSeenAt)
        return [platform, seen].compactMap { $0 }.joined(separator: " · ")
    }
}
