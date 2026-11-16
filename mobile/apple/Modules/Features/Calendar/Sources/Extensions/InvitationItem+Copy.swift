import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Copy
extension InvitationItem {

    /// Who invites, or that something was added to a shared calendar, above the title.
    var kicker: String {
        switch kind {
        case .invite:
            guard let organizerName, !organizerName.isEmpty else {
                return String(localized: "invitations.kicker.inviteAnonymous", table: "Sheets", bundle: .module)
            }
            return String(
                format: String(localized: "invitations.kicker.invite", table: "Sheets", bundle: .module),
                locale: .current,
                organizerName
            )
        case .sharedCalendarNotice:
            return String(localized: "invitations.kicker.notice", table: "Sheets", bundle: .module)
        }
    }

    /// The day and the time, `pá 23. 10. · 19:00–22:00`.
    var when: String? {
        InvitationDates.when(
            startsAt: startsAt,
            endsAt: endsAt,
            timeZone: timeZone,
            allDay: allDay,
            allDayText: String(localized: "invitations.allDay", table: "Sheets", bundle: .module)
        )
    }

    /// The place, and for a notice also who added it, under the time.
    var meta: String? {
        let parts = kind == .invite ? [place] : [organizerName, place]
        let shown = parts.compactMap { $0 }.filter { !$0.isEmpty }
        return shown.isEmpty ? nil : shown.joined(separator: " · ")
    }

    /// The answer an answered invitation carries; `nil` while it waits for one.
    var statusLabel: String? {
        switch status {
        case .pending: nil
        case .accepted: String(localized: "invitations.status.accepted", table: "Sheets", bundle: .module)
        case .tentative: String(localized: "invitations.status.tentative", table: "Sheets", bundle: .module)
        case .declined: String(localized: "invitations.status.declined", table: "Sheets", bundle: .module)
        case .acknowledged: String(localized: "invitations.status.acknowledged", table: "Sheets", bundle: .module)
        case .cancelled: String(localized: "invitations.status.cancelled", table: "Sheets", bundle: .module)
        }
    }

    /// The system colour of the answer's chip.
    var statusTint: Color {
        switch status {
        case .accepted: .green
        case .tentative: .orange
        case .declined, .cancelled: Theme.Colors.destructive
        case .pending, .acknowledged: Theme.Colors.secondaryText
        }
    }
}
