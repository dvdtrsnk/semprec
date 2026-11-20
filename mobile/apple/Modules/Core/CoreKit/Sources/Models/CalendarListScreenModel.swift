import Foundation

// MARK: - Calendars list

public enum CalendarListPhase: Equatable, Sendable {

    case loading
    case content
    /// `nil` for an unexpected failure, which has no typed reason.
    case failure(FailureKind?)
}

/// Where a calendar comes from, which decides what can be done with it.
public enum CalendarGroup: Equatable, Sendable {

    case own
    case system
    case subscription
    case account
}

/// A colour a calendar can take; `key` names it for the copy, `hex` is `#RRGGBB`.
public struct CalendarSwatch: Equatable, Sendable, Identifiable {

    public let key: String
    public let hex: String

    public var id: String { key }

    public init(key: String, hex: String) {
        self.key = key
        self.hex = hex
    }
}

/// A calendar of the list. `systemKey` is `tasks`, `birthdays`, `sleep` or `holidaysCz` for one Semprec fills. A
/// calendar of the `account` group belongs to the section `accountId` (empty when the server did not say which
/// account) and carries the provider's `remoteName` and `remoteColor`; `usesRemoteColor` says its colour is the
/// provider's. A `readOnly` calendar takes no new events.
public struct CalendarRow: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String
    public let color: String
    public let hidden: Bool
    public let notify: Bool
    public let group: CalendarGroup
    public let systemKey: String?
    public let isDefault: Bool
    public let canRename: Bool
    public let canDelete: Bool
    public let accountId: String?
    public let readOnly: Bool
    public let remoteName: String?
    public let remoteColor: String?
    public let usesRemoteColor: Bool

    public init(
        id: String,
        name: String,
        color: String,
        hidden: Bool = false,
        notify: Bool = true,
        group: CalendarGroup = .own,
        systemKey: String? = nil,
        isDefault: Bool = false,
        canRename: Bool = true,
        canDelete: Bool = true,
        accountId: String? = nil,
        readOnly: Bool = false,
        remoteName: String? = nil,
        remoteColor: String? = nil,
        usesRemoteColor: Bool = false
    ) {
        self.id = id
        self.name = name
        self.color = color
        self.hidden = hidden
        self.notify = notify
        self.group = group
        self.systemKey = systemKey
        self.isDefault = isDefault
        self.canRename = canRename
        self.canDelete = canDelete
        self.accountId = accountId
        self.readOnly = readOnly
        self.remoteName = remoteName
        self.remoteColor = remoteColor
        self.usesRemoteColor = usesRemoteColor
    }
}

/// An internet account whose calendars the list shows, in the order of the sections. `name` and `provider` (`gmail`,
/// `outlook`, `icloud`, `imap`) are `nil` when the accounts could not be read or the account is not among them;
/// `status` is then `nil` too.
public struct CalendarAccountSection: Equatable, Sendable, Identifiable {

    public let id: String
    public let name: String?
    public let provider: String?
    public let status: InternetServiceStatus?

    public init(id: String, name: String? = nil, provider: String? = nil, status: InternetServiceStatus? = nil) {
        self.id = id
        self.name = name
        self.provider = provider
        self.status = status
    }
}

/// What deleting a calendar would cancel, shown before the delete is confirmed.
public struct CalendarImpact: Equatable, Sendable {

    public let calendarId: String
    public let eventCount: Int
    public let recipientCount: Int
    public let cancellationCount: Int

    public init(calendarId: String, eventCount: Int, recipientCount: Int, cancellationCount: Int) {
        self.calendarId = calendarId
        self.eventCount = eventCount
        self.recipientCount = recipientCount
        self.cancellationCount = cancellationCount
    }
}

/// The calendars sheet. `accounts` are the internet accounts of the `account` calendars, one section each.
/// `detailId` is the calendar whose settings are open; `impact` is a delete waiting for its confirmation.
public struct CalendarListState: Equatable, Sendable {

    public var phase: CalendarListPhase
    public var calendars: [CalendarRow]
    public var accounts: [CalendarAccountSection]
    public var swatches: [CalendarSwatch]
    public var detailId: String?
    public var impact: CalendarImpact?
    public var busy: Bool
    public var problem: Bool
    public var problemFailure: FailureKind?

    public init(
        phase: CalendarListPhase,
        calendars: [CalendarRow] = [],
        accounts: [CalendarAccountSection] = [],
        swatches: [CalendarSwatch] = [],
        detailId: String? = nil,
        impact: CalendarImpact? = nil,
        busy: Bool = false,
        problem: Bool = false,
        problemFailure: FailureKind? = nil
    ) {
        self.phase = phase
        self.calendars = calendars
        self.accounts = accounts
        self.swatches = swatches
        self.detailId = detailId
        self.impact = impact
        self.busy = busy
        self.problem = problem
        self.problemFailure = problemFailure
    }
}

public enum CalendarListAction: Equatable, Sendable {

    case retry
    /// Pulled to refresh: reads the list again and asks the server to sync the internet accounts' calendars.
    case refresh
    case change(CalendarListChange)
    case setAllHidden(Bool)
    case openDetail(calendarId: String)
    case closeDetail
    case add(name: String)
    case requestDelete(calendarId: String)
    case confirmDelete
    case cancelDelete
    case openSleep
    case dismissProblem
}

/// A change to one calendar, written at once.
public enum CalendarListChange: Equatable, Sendable {

    case toggleHidden(calendarId: String)
    case rename(calendarId: String, name: String)
    case setColor(calendarId: String, color: String)
    case setNotify(calendarId: String, notify: Bool)
    /// An account calendar shows the provider's colour again instead of the one set here.
    case useRemoteColor(calendarId: String)
}

public enum CalendarListEffect: Equatable, Sendable {

    case openSleep
}

public typealias CalendarListScreenModel = ScreenModel<CalendarListState, CalendarListAction, CalendarListEffect>

/// Calendars sheet model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedCalendarListScreenModel =
    ScriptedScreenModel<CalendarListState, CalendarListAction, CalendarListEffect>
