@preconcurrency internal import SharedSDK

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

// MARK: - CalendarGroup
extension CalendarGroup {

    init(_ group: SharedSDK.CalendarGroup) {
        switch group {
        case .own: self = .own
        case .system: self = .system
        case .subscription: self = .subscription
        case .account: self = .account
        }
    }
}

// MARK: - CalendarAccountSection
extension CalendarAccountSection {

    init(_ section: SharedSDK.CalendarAccountSection) {
        self.init(
            id: section.id,
            name: section.name,
            provider: section.provider,
            status: section.status.map(InternetServiceStatus.init),
            address: section.address
        )
    }
}

// MARK: - CalendarSwatch
extension CalendarSwatch {

    init(_ swatch: SharedSDK.CalendarSwatch) {
        self.init(key: swatch.key, hex: swatch.hex)
    }
}

// MARK: - CalendarRow
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
            canDelete: row.canDelete,
            accountId: row.accountId,
            readOnly: row.readOnly,
            remoteName: row.remoteName,
            remoteColor: row.remoteColor,
            usesRemoteColor: row.usesRemoteColor
        )
    }
}

// MARK: - CalendarImpact
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
