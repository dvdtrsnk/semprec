/// How a new item repeats from its day: every day, Monday to Friday, on its weekday, on its day of the month or every
/// year on its date. An event repeats at most monthly.
public enum NewItemRepeat: Equatable, Sendable, CaseIterable {

    case never
    case daily
    case weekdays
    case weekly
    case monthly
    case yearly
}
