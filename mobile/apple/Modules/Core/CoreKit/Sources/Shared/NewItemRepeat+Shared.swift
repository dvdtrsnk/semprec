@preconcurrency internal import SharedSDK

// MARK: - NewItemRepeat
extension NewItemRepeat {

    var shared: SharedSDK.NewItemRepeat {
        switch self {
        case .never: .never
        case .daily: .daily
        case .weekdays: .weekdays
        case .weekly: .weekly
        case .monthly: .monthly
        case .yearly: .yearly
        }
    }
}
