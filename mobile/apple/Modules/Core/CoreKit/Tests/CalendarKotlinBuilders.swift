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
            tasks: tasks,
            hostEventTitle: "Review",
            carriedFrom: "2026-10-14",
            trace: trace,
            traceNote: "2026-10-15"
        )
    }

    static func sleep() -> SharedSDK.CalendarSleep {
        SharedSDK.CalendarSleep(
            night: "2026-10-15",
            bedMinutes: 1380,
            wakeMinutes: 405,
            alarm: true,
            changed: true,
            prepMinutes: KotlinInt(int: 1350)
        )
    }

    static func state(
        _ phase: SharedSDK.CalendarPhase,
        failure: SharedSDK.FailureKind? = nil,
        zoom: SharedSDK.CalendarZoom = .day,
        days: [SharedSDK.CalendarDayState] = [],
        drag: SharedSDK.CalendarDrag? = nil,
        clipboard: SharedSDK.CalendarClipboard? = nil,
        pendingDelete: SharedSDK.CalendarDeleteRequest? = nil,
        problemFailure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.CalendarState {
        SharedSDK.CalendarState(
            phase: phase,
            failure: failure,
            zoom: zoom,
            selectedDay: "2026-10-16",
            today: "2026-10-15",
            nowMinutes: 804,
            days: days,
            monthGrid: ["2026-09-28", "2026-09-29"],
            months: [SharedSDK.CalendarMonthState(year: 2026, month: 10, leading: 3, length: 31)],
            pendingInvitations: 3,
            selectedItemId: "e1",
            drag: drag,
            clipboard: clipboard,
            pendingDelete: pendingDelete,
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
            systemKey: systemKey, isDefault: true, canRename: false, canDelete: true
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
            calendars: [SharedSDK.NewItemCalendar(id: "c1", name: "Work", color: "#007AFF", isDefault: true)],
            defaultDay: "2026-10-17"
        )
    }
}
