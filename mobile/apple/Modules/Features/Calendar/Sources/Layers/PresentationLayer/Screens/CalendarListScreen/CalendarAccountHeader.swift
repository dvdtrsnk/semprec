import CoreKit
import DesignSystem
import SwiftUI

/// The header of an internet account's calendars: the provider's badge, the account's name and how its calendar sync
/// is doing.
struct CalendarAccountHeader: View {

    // MARK: - Dependencies
    let account: CalendarAccountSection

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            InternetAccountProviderBadge(provider: account.provider, size: Self.badgeSize)
            VStack(alignment: .leading, spacing: 0) {
                Text(name)
                if let status = account.status {
                    Text(status.calendarsText)
                        .font(.caption)
                        .textCase(nil)
                        .foregroundStyle(status.needsAttention ? Theme.Colors.destructive : Theme.Colors.secondaryText)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(CalendarSheetIdentifiers.calendarAccount(account.id))
    }
}

// MARK: - Subviews
private extension CalendarAccountHeader {

    static let badgeSize: CGFloat = 22

    var name: String {
        account.name ?? String(localized: "calendars.account.unnamed", table: "Sheets", bundle: .module)
    }
}

// MARK: - Preview
#Preview("Headers") {
    List {
        Section {
            Text(verbatim: "Rodina")
        } header: {
            CalendarAccountHeader(
                account: CalendarAccountSection(id: "m1", name: "Gmail", provider: "gmail", status: .ok)
            )
        }
        Section {
            Text(verbatim: "Práce")
        } header: {
            CalendarAccountHeader(
                account: CalendarAccountSection(id: "m2", name: "Outlook", provider: "outlook", status: .needsConsent)
            )
        }
        Section {
            Text(verbatim: "Sdílený")
        } header: {
            CalendarAccountHeader(account: CalendarAccountSection(id: ""))
        }
    }
}
