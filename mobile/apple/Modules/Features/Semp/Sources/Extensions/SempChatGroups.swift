import CoreKit
import Foundation

/// The history of chats cut into the groups the list shows, newest first: today, yesterday, the week before, then a
/// group per month.
enum SempChatGroups {

    // MARK: - Group
    enum Title: Equatable {

        case today
        case yesterday
        case previousWeek
        case month(Date)
    }

    struct Group: Equatable, Identifiable {

        let title: Title
        let rows: [SempChatRow]

        var id: String {
            switch title {
            case .today: "today"
            case .yesterday: "yesterday"
            case .previousWeek: "week"
            case .month(let date): "month-\(date.timeIntervalSince1970)"
            }
        }
    }

    // MARK: - Methods
    /// Groups `rows`, which come newest first, by how long ago their last activity was; a row without a readable time
    /// goes to the oldest group.
    static func group(_ rows: [SempChatRow], now: Date = .now, calendar: Calendar = .current) -> [Group] {
        var groups: [Group] = []
        for row in rows {
            let title = title(for: row, now: now, calendar: calendar)
            if let last = groups.last, last.title == title {
                groups[groups.count - 1] = Group(title: title, rows: last.rows + [row])
            } else {
                groups.append(Group(title: title, rows: [row]))
            }
        }
        return groups
    }

    private static func title(for row: SempChatRow, now: Date, calendar: Calendar) -> Title {
        guard let date = SempTime.date(row.lastActivityAt) else { return .month(.distantPast) }
        let today = calendar.startOfDay(for: now)
        let day = calendar.startOfDay(for: date)
        let gone = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        switch gone {
        case ..<1: return .today
        case 1: return .yesterday
        case 2...7: return .previousWeek
        default:
            let month = calendar.dateInterval(of: .month, for: date)?.start ?? day
            return .month(month)
        }
    }
}
