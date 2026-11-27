@preconcurrency internal import SharedSDK

// MARK: - Shared search kinds
extension SearchGroupType {

    init(_ type: SharedSDK.SearchGroupType) {
        switch type {
        case .task: self = .task
        case .event: self = .event
        case .project: self = .project
        case .contact: self = .contact
        case .journal: self = .journal
        case .file: self = .file
        case .mail: self = .mail
        case .chat: self = .chat
        }
    }

    var shared: SharedSDK.SearchGroupType {
        switch self {
        case .task: .task
        case .event: .event
        case .project: .project
        case .contact: .contact
        case .journal: .journal
        case .file: .file
        case .mail: .mail
        case .chat: .chat
        }
    }
}

// MARK: - Shared subtitle kinds
extension SearchSubtitleKind {

    init(_ kind: SharedSDK.SearchSubtitleKind) {
        switch kind {
        case .date: self = .date
        case .time: self = .time
        case .timeRange: self = .timeRange
        case .place: self = .place
        case .recurrence: self = .recurrence
        case .project: self = .project
        case .people: self = .people
        case .phone: self = .phone
        case .relationship: self = .relationship
        case .status: self = .status
        case .count: self = .count
        case .sender: self = .sender
        case .movedFrom: self = .movedFrom
        case .missedInEvent: self = .missedInEvent
        }
    }
}
