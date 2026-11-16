@preconcurrency internal import SharedSDK

// MARK: - Enumerations
extension CalendarZoom {

    init(_ zoom: SharedSDK.CalendarZoom) {
        switch zoom {
        case .year: self = .year
        case .month: self = .month
        case .day: self = .day
        }
    }

    var shared: SharedSDK.CalendarZoom {
        switch self {
        case .year: .year
        case .month: .month
        case .day: .day
        }
    }
}

extension CalendarPhase {

    init(_ phase: SharedSDK.CalendarPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

extension CalendarItemKind {

    init(_ kind: SharedSDK.CalendarItemKind) {
        switch kind {
        case .event: self = .event
        case .task: self = .task
        case .birthday: self = .birthday
        case .holiday: self = .holiday
        case .sleep: self = .sleep
        case .trace: self = .trace
        }
    }
}

extension CalendarTaskInEvent {

    init(_ state: SharedSDK.CalendarTaskInEvent) {
        switch state {
        case .open: self = .open
        case .missed: self = .missed
        case .done: self = .done
        case .doneElsewhere: self = .doneElsewhere
        case .moved: self = .moved
        }
    }
}

extension CalendarTraceOutcome {

    init(_ outcome: SharedSDK.CalendarTraceOutcome) {
        switch outcome {
        case .carried: self = .carried
        case .done: self = .done
        case .movedToEvent: self = .movedToEvent
        case .missed: self = .missed
        }
    }
}

extension CalendarEdge {

    var shared: SharedSDK.CalendarEdge {
        switch self {
        case .start: .start
        case .end: .end
        }
    }
}

extension CalendarClipboardMode {

    init(_ mode: SharedSDK.CalendarClipboardMode) {
        switch mode {
        case .cut: self = .cut
        case .copied: self = .copied
        }
    }
}

// MARK: - Items
extension CalendarEventTask {

    init(_ task: SharedSDK.CalendarEventTask) {
        self.init(id: task.id, title: task.title, state: CalendarTaskInEvent(task.state), note: task.note)
    }
}

extension CalendarSleep {

    init(_ sleep: SharedSDK.CalendarSleep) {
        self.init(
            night: sleep.night,
            bedMinutes: Int(sleep.bedMinutes),
            wakeMinutes: Int(sleep.wakeMinutes),
            alarm: sleep.alarm,
            changed: sleep.changed,
            prepMinutes: sleep.prepMinutes.map { Int(truncating: $0) }
        )
    }
}

extension CalendarItem {

    init(_ item: SharedSDK.CalendarItem) {
        self.init(
            id: item.id,
            kind: CalendarItemKind(item.kind),
            title: item.title,
            color: item.color,
            date: item.date,
            endDate: item.endDate,
            allDay: item.allDay,
            startMinutes: item.startMinutes.map { Int(truncating: $0) },
            endMinutes: item.endMinutes.map { Int(truncating: $0) },
            hasEnd: item.hasEnd,
            done: item.done,
            missed: item.missed,
            place: item.place,
            tentative: item.tentative,
            editable: item.editable,
            column: Int(item.column),
            columns: Int(item.columns),
            tasks: item.tasks.map(CalendarEventTask.init),
            hostEventTitle: item.hostEventTitle,
            carriedFrom: item.carriedFrom,
            trace: item.trace.map(CalendarTraceOutcome.init),
            traceNote: item.traceNote
        )
    }
}

extension CalendarDayState {

    init(_ day: SharedSDK.CalendarDayState) {
        self.init(
            date: day.date,
            items: day.items.map(CalendarItem.init),
            sleepEvening: day.sleepEvening.map(CalendarSleep.init),
            sleepMorning: day.sleepMorning.map(CalendarSleep.init)
        )
    }
}

extension CalendarMonthState {

    init(_ month: SharedSDK.CalendarMonthState) {
        self.init(
            year: Int(month.year),
            month: Int(month.month),
            leading: Int(month.leading),
            length: Int(month.length)
        )
    }
}

extension CalendarDrag {

    init(_ drag: SharedSDK.CalendarDrag) {
        self.init(
            itemId: drag.itemId,
            date: drag.date,
            allDay: drag.allDay,
            startMinutes: drag.startMinutes.map { Int(truncating: $0) },
            endMinutes: drag.endMinutes.map { Int(truncating: $0) },
            intoEventId: drag.intoEventId,
            committing: drag.committing
        )
    }
}

extension CalendarClipboard {

    init(_ clipboard: SharedSDK.CalendarClipboard) {
        self.init(mode: CalendarClipboardMode(clipboard.mode), title: clipboard.title)
    }
}

extension CalendarDeleteRequest {

    init(_ request: SharedSDK.CalendarDeleteRequest) {
        self.init(itemId: request.itemId, title: request.title, kind: CalendarItemKind(request.kind))
    }
}

// MARK: - Calendars list
extension CalendarListPhase {

    init(_ phase: SharedSDK.CalendarListPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

extension CalendarGroup {

    init(_ group: SharedSDK.CalendarGroup) {
        switch group {
        case .own: self = .own
        case .system: self = .system
        case .subscription: self = .subscription
        }
    }
}

extension CalendarSwatch {

    init(_ swatch: SharedSDK.CalendarSwatch) {
        self.init(key: swatch.key, hex: swatch.hex)
    }
}

extension CalendarRow {

    init(_ row: SharedSDK.CalendarRow) {
        self.init(
            id: row.id,
            name: row.name,
            color: row.color,
            hidden: row.hidden,
            notify: row.notify,
            group: CalendarGroup(row.group),
            systemKey: row.systemKey,
            isDefault: row.isDefault,
            canRename: row.canRename,
            canDelete: row.canDelete
        )
    }
}

extension CalendarImpact {

    init(_ impact: SharedSDK.CalendarImpact) {
        self.init(
            calendarId: impact.calendarId,
            eventCount: Int(impact.eventCount),
            recipientCount: Int(impact.recipientCount),
            cancellationCount: Int(impact.cancellationCount)
        )
    }
}

// MARK: - Invitations
extension InvitationsPhase {

    init(_ phase: SharedSDK.InvitationsPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

extension InvitationsTab {

    init(_ tab: SharedSDK.InvitationsTab) {
        switch tab {
        case .pending: self = .pending
        case .answered: self = .answered
        }
    }

    var shared: SharedSDK.InvitationsTab {
        switch self {
        case .pending: .pending
        case .answered: .answered
        }
    }
}

extension InvitationItemKind {

    init(_ kind: SharedSDK.InvitationItemKind) {
        switch kind {
        case .invite: self = .invite
        case .sharedCalendarNotice: self = .sharedCalendarNotice
        }
    }
}

extension InvitationItemStatus {

    init(_ status: SharedSDK.InvitationItemStatus) {
        switch status {
        case .pending: self = .pending
        case .accepted: self = .accepted
        case .tentative: self = .tentative
        case .declined: self = .declined
        case .acknowledged: self = .acknowledged
        case .cancelled: self = .cancelled
        }
    }
}

extension InvitationReply {

    var shared: SharedSDK.InvitationReply {
        switch self {
        case .accept: .accept
        case .tentative: .tentative
        case .decline: .decline
        case .acknowledge: .acknowledge
        }
    }
}

extension InvitationItem {

    init(_ item: SharedSDK.InvitationItem) {
        self.init(
            id: item.id,
            kind: InvitationItemKind(item.kind),
            status: InvitationItemStatus(item.status),
            title: item.title,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            timeZone: item.timeZone,
            allDay: item.allDay,
            place: item.place,
            organizerName: item.organizerName
        )
    }
}

// MARK: - New item
extension NewItemPhase {

    init(_ phase: SharedSDK.NewItemPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .editing: self = .editing
        case .saving: self = .saving
        case .failed: self = .failed(failure.map(FailureKind.init))
        }
    }
}

extension NewItemKind {

    var shared: SharedSDK.NewItemKind {
        switch self {
        case .event: .event
        case .task: .task
        }
    }
}

extension NewItemCalendar {

    init(_ calendar: SharedSDK.NewItemCalendar) {
        self.init(id: calendar.id, name: calendar.name, color: calendar.color, isDefault: calendar.isDefault)
    }
}
