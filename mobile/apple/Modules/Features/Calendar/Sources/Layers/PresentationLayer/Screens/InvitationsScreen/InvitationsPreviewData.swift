import CoreKit
import Foundation

// MARK: - Preview data
extension InvitationsState {

    static var previewPending: InvitationsState {
        InvitationsState(
            phase: .content,
            tab: .pending,
            items: [
                InvitationItem(
                    id: "i1", title: "Sprint review", startsAt: "2026-10-22T11:00:00.000Z",
                    endsAt: "2026-10-22T12:00:00.000Z", timeZone: "Europe/Prague", place: "Kancelář, Karlín",
                    organizerName: "Petr Novák"
                ),
                InvitationItem(
                    id: "i2", title: "Večeře u Tomáše", startsAt: "2026-10-23T17:00:00Z",
                    endsAt: "2026-10-23T20:00:00Z", timeZone: "Europe/Prague", place: "Vinohrady",
                    organizerName: "Tomáš Dvořák"
                ),
                InvitationItem(
                    id: "i3", kind: .sharedCalendarNotice, title: "Rodičovská schůzka",
                    startsAt: "2026-10-20T15:00:00Z", endsAt: "2026-10-20T16:00:00Z", timeZone: "Europe/Prague",
                    organizerName: "Jana"
                )
            ],
            pending: 3
        )
    }

    static var previewAnswered: InvitationsState {
        InvitationsState(
            phase: .content,
            tab: .answered,
            items: [
                InvitationItem(
                    id: "a1", status: .accepted, title: "Sprint review", startsAt: "2026-10-22T11:00:00Z",
                    endsAt: "2026-10-22T12:00:00Z", timeZone: "Europe/Prague", place: "Kancelář, Karlín",
                    organizerName: "Petr Novák"
                ),
                InvitationItem(
                    id: "a2", status: .tentative, title: "Večeře u Tomáše", startsAt: "2026-10-23T17:00:00Z",
                    endsAt: "2026-10-23T20:00:00Z", timeZone: "Europe/Prague", organizerName: "Tomáš Dvořák"
                ),
                InvitationItem(
                    id: "a3", kind: .sharedCalendarNotice, status: .acknowledged, title: "Státní svátek",
                    startsAt: "2026-10-27T23:00:00Z", endsAt: "2026-10-28T23:00:00Z", timeZone: "Europe/Prague",
                    allDay: true, organizerName: "Jana"
                )
            ],
            pending: 0
        )
    }
}
