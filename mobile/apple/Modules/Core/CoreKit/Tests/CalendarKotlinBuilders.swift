import SharedSDK

/// Kotlin calendar values for the mapping tests; the real ViewModels, which need a signed-in server, never reach most
/// of the branches these exercise. Both modules declare the same type names, so each Kotlin type is qualified.
enum CalendarKotlin {

    // MARK: - Builders
    static func item(
        id: String = "e1",
        kind: SharedSDK.CalendarItemKind = .event,
        allDay: Bool = false,
        start: Int32? = 600,
        end: Int32? = 660,
        tasks: [SharedSDK.CalendarEventTask] = [],
        trace: SharedSDK.CalendarTraceOutcome? = nil
    ) -> SharedSDK.CalendarItem {
        SharedSDK.CalendarItem(
            id: id,
            kind: kind,
            title: "Meeting",
            color: "#007AFF",
            date: "2026-10-16",
            endDate: "2026-10-18",
            allDay: allDay,
            startMinutes: start.map { KotlinInt(int: $0) },
            endMinutes: end.map { KotlinInt(int: $0) },
            hasEnd: true,
            done: true,
            missed: true,
            place: "Office",
            tentative: true,
            editable: false,
            column: 1,
            columns: 3,
            depth: 2,
            tasks: tasks,
            hostEventTitle: "Review",
            carriedFrom: "2026-10-14",
            trace: trace,
            traceNote: "2026-10-15",
            timeFrom: start.map { KotlinInt(int: $0) },
            timeTo: end.map { KotlinInt(int: $0) }
        )
    }

    static func sleep() -> SharedSDK.CalendarSleep {
        SharedSDK.CalendarSleep(
            night: "2026-10-15",
            bedMinutes: 1380,
            wakeMinutes: 405,
            alarm: true,
            changed: true,
            prepMinutes: KotlinInt(int: 1350),
            fromMinutes: 1380,
            toMinutes: 1440,
            planBedMinutes: KotlinInt(int: 1350),
            planWakeMinutes: KotlinInt(int: 405),
            durationMinutes: 465,
            goalMinutes: KotlinInt(int: 480),
            meetsGoal: KotlinBoolean(bool: false)
        )
    }

    /// The part of the same night that falls on the morning after: midnight to waking, without the reminder.
    static func morningSleep(prepMinutes: Int32? = nil) -> SharedSDK.CalendarSleep {
        SharedSDK.CalendarSleep(
            night: "2026-10-15",
            bedMinutes: 1380,
            wakeMinutes: 405,
            alarm: true,
            changed: false,
            prepMinutes: prepMinutes.map { KotlinInt(int: $0) },
            fromMinutes: 0,
            toMinutes: 405,
            planBedMinutes: nil,
            planWakeMinutes: nil,
            durationMinutes: 0,
            goalMinutes: nil,
            meetsGoal: nil
        )
    }

    static func state(
        _ phase: SharedSDK.CalendarPhase,
        failure: SharedSDK.FailureKind? = nil,
        zoom: SharedSDK.CalendarZoom = .day,
        days: [SharedSDK.CalendarDayState] = [],
        drag: SharedSDK.CalendarDrag? = nil,
        sleepDrag: SharedSDK.CalendarSleepDrag? = nil,
        clipboard: SharedSDK.CalendarClipboard? = nil,
        problemFailure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.CalendarState {
        SharedSDK.CalendarState(
            phase: phase,
            failure: failure,
            zoom: zoom,
            selectedDay: "2026-10-16",
            today: "2026-10-15",
            nowMinutes: 804,
            timezone: "Europe/Prague",
            days: days,
            monthGrid: ["2026-09-28", "2026-09-29"],
            months: [SharedSDK.CalendarMonthState(year: 2026, month: 10, leading: 3, length: 31)],
            pendingInvitations: 3,
            selectedItemId: "e1",
            drag: drag,
            sleepDrag: sleepDrag,
            clipboard: clipboard,
            busy: true,
            problem: true,
            problemFailure: problemFailure
        )
    }

    static func row(
        group: SharedSDK.CalendarGroup = .own,
        systemKey: String? = nil
    ) -> SharedSDK.CalendarRow {
        SharedSDK.CalendarRow(
            id: "c1", name: "Work", color: "#007AFF", hidden: true, notify: false, group: group,
            systemKey: systemKey, isDefault: true, canRename: false, canDelete: true, accountId: nil, readOnly: false,
            remoteName: nil, remoteColor: nil, usesRemoteColor: false
        )
    }

    static func accountRow() -> SharedSDK.CalendarRow {
        SharedSDK.CalendarRow(
            id: "g1", name: "Family", color: "#0B8043", hidden: false, notify: true, group: .account,
            systemKey: nil, isDefault: false, canRename: true, canDelete: false, accountId: "m1", readOnly: true,
            remoteName: "Rodina", remoteColor: "#16A765", usesRemoteColor: true
        )
    }

    static func listState(
        _ phase: SharedSDK.CalendarListPhase,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.CalendarListState {
        SharedSDK.CalendarListState(
            phase: phase,
            failure: failure,
            calendars: [row()],
            accounts: [
                SharedSDK.CalendarAccountSection(
                    id: "m1", name: "Gmail", provider: "gmail", status: .needsConsent, address: "me@gmail.com"
                ),
                SharedSDK.CalendarAccountSection(id: "", name: nil, provider: nil, status: nil, address: nil)
            ],
            swatches: [SharedSDK.CalendarSwatch(key: "red", hex: "#FF3B30")],
            detailId: "c1",
            impact: SharedSDK.CalendarImpact(calendarId: "c1", eventCount: 4, recipientCount: 2, cancellationCount: 1),
            busy: true,
            problem: true,
            problemFailure: .rejected
        )
    }

    static func invitation(
        kind: SharedSDK.InvitationItemKind = .invite,
        status: SharedSDK.InvitationItemStatus = .pending
    ) -> SharedSDK.InvitationItem {
        SharedSDK.InvitationItem(
            id: "i1", kind: kind, status: status, title: "Review", startsAt: "2026-10-22T11:00:00.000Z",
            endsAt: "2026-10-22T12:00:00.000Z", timeZone: "Europe/Prague", allDay: false, place: "Office",
            organizerName: "Petr"
        )
    }

    static func invitationsState(
        _ phase: SharedSDK.InvitationsPhase,
        failure: SharedSDK.FailureKind? = nil,
        tab: SharedSDK.InvitationsTab = .pending,
        items: [SharedSDK.InvitationItem] = []
    ) -> SharedSDK.InvitationsState {
        SharedSDK.InvitationsState(
            phase: phase, failure: failure, tab: tab, items: items, pending: 2, answering: "i1",
            problem: true, problemFailure: .unavailable
        )
    }

    static func newItemState(
        _ phase: SharedSDK.NewItemPhase,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.NewItemState {
        SharedSDK.NewItemState(
            phase: phase,
            failure: failure,
            groups: [
                SharedSDK.NewItemCalendarGroup(
                    account: nil,
                    calendars: [
                        SharedSDK.NewItemCalendar(
                            id: "c1", name: "Osobní", color: "#007AFF", isDefault: true, account: nil, qualifier: .own
                        )
                    ]
                ),
                SharedSDK.NewItemCalendarGroup(
                    account: icloud,
                    calendars: [
                        SharedSDK.NewItemCalendar(
                            id: "g1", name: "Osobní", color: "#0B8043", isDefault: false, account: icloud,
                            qualifier: .accountName
                        ),
                        SharedSDK.NewItemCalendar(
                            id: "g2", name: "Rodina", color: "#16A765", isDefault: false, account: icloud,
                            qualifier: .accountAddress
                        ),
                        SharedSDK.NewItemCalendar(
                            id: "g3", name: "Work", color: "#16A765", isDefault: false, account: icloud,
                            qualifier: .none
                        )
                    ]
                ),
                SharedSDK.NewItemCalendarGroup(
                    account: SharedSDK.NewItemAccount(id: "", name: nil, address: nil),
                    calendars: []
                )
            ],
            defaultDay: "2026-10-17"
        )
    }

    static var icloud: SharedSDK.NewItemAccount {
        SharedSDK.NewItemAccount(id: "m1", name: "iCloud", address: "david@tresnak.cc")
    }
}
