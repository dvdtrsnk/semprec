import CoreKit
import DesignSystem
import SwiftUI

/// A dot in the color of what a service is doing, with the service's name and that status when `named`, or the
/// status alone.
struct InternetServiceStatusLabel: View {

    // MARK: - Dependencies
    let service: InternetAccountService
    let status: InternetServiceStatus
    var named = true

    // MARK: - Body
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(verbatim: text).font(.caption.weight(.medium)).foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Private
    private var text: String {
        guard named else { return Self.title(status) }
        let format = String(localized: "internetAccounts.serviceStatus", bundle: .module)
        return String(format: format, locale: .current, Self.name(service), Self.title(status))
    }

    private var color: Color {
        switch status {
        case .ok: .green
        case .pending, .syncing: .orange
        case .error, .needsReauthorization, .needsConsent: Theme.Colors.destructive
        case .off: Theme.Colors.secondaryText
        }
    }
}

// MARK: - Words
extension InternetServiceStatusLabel {

    static func name(_ service: InternetAccountService) -> String {
        switch service {
        case .mail: String(localized: "internetAccounts.service.mail", bundle: .module)
        case .calendars: String(localized: "internetAccounts.service.calendars", bundle: .module)
        }
    }

    static func title(_ status: InternetServiceStatus) -> String {
        switch status {
        case .off: String(localized: "internetAccounts.status.off", bundle: .module)
        case .pending: String(localized: "internetAccounts.status.pending", bundle: .module)
        case .syncing: String(localized: "internetAccounts.status.syncing", bundle: .module)
        case .ok: String(localized: "internetAccounts.status.ok", bundle: .module)
        case .error: String(localized: "internetAccounts.status.error", bundle: .module)
        case .needsReauthorization: String(localized: "internetAccounts.status.reauth", bundle: .module)
        case .needsConsent: String(localized: "internetAccounts.status.consent", bundle: .module)
        }
    }
}
