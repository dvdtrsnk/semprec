import CoreKit
import Foundation

/// Composes the subtitle of a search result from the pieces the server names. The server sends canonical values
/// (a date, a time, a stored key); the words, the relative days and the separators are the app's.
struct SearchSubtitle {

    // MARK: - Properties
    let date: DisplayDate
    var locale: Locale = .current

    private static let separator = " \u{00B7} "

    // MARK: - Methods
    func text(for parts: [SearchSubtitlePart]) -> String {
        var segments: [String] = []
        var previousWasDate = false
        for part in parts {
            guard let segment = segment(for: part) else { continue }
            let isTime = part.kind == .time || part.kind == .timeRange
            if isTime, previousWasDate, let last = segments.popLast() {
                segments.append("\(last) \(segment)")
            } else {
                segments.append(segment)
            }
            previousWasDate = part.kind == .date
        }
        return segments.joined(separator: Self.separator)
    }
}

// MARK: - Pieces
private extension SearchSubtitle {

    func segment(for part: SearchSubtitlePart) -> String? {
        switch part.kind {
        case .date: date.text(iso: part.value)
        case .time: part.value
        case .timeRange: DisplayDate.time(part.value)
        case .place, .project, .people, .phone, .sender: part.value
        case .recurrence: recurrence(part.value)
        case .relationship: relationship(part.value)
        case .status: status(part.value)
        case .movedFrom:
            date.text(iso: part.value).map { String(format: localized("search.movedFrom"), locale: locale, $0) }
        case .missedInEvent: String(format: localized("search.missedInEvent"), locale: locale, part.value)
        }
    }

    func localized(_ key: String) -> String {
        String(localized: String.LocalizationValue(key), bundle: .module, locale: locale)
    }

    func recurrence(_ key: String) -> String? {
        switch key {
        case "daily": localized("search.recurrence.daily")
        case "weekdays": localized("search.recurrence.weekdays")
        case "weekly": localized("search.recurrence.weekly")
        case "monthly": localized("search.recurrence.monthly")
        case "custom": localized("search.recurrence.custom")
        default: nil
        }
    }

    func relationship(_ key: String) -> String? {
        switch key {
        case "client": localized("search.relationship.client")
        case "closeFriend": localized("search.relationship.closeFriend")
        case "parent": localized("search.relationship.parent")
        case "girlfriend": localized("search.relationship.girlfriend")
        case "therapist": localized("search.relationship.therapist")
        case "neighbor": localized("search.relationship.neighbor")
        case "colleague": localized("search.relationship.colleague")
        case "craftsman": localized("search.relationship.craftsman")
        case "doctor": localized("search.relationship.doctor")
        case "company": localized("search.relationship.company")
        default: nil
        }
    }

    func status(_ key: String) -> String? {
        switch key {
        case "notDone": localized("search.status.notDone")
        case "done": localized("search.status.done")
        case "wontDo": localized("search.status.wontDo")
        case "missed": localized("search.status.missed")
        case "inProgress": localized("search.status.inProgress")
        case "longTerm": localized("search.status.longTerm")
        case "archived": localized("search.status.archived")
        case "monitoring": localized("search.status.monitoring")
        case "resolved": localized("search.status.resolved")
        default: nil
        }
    }
}
