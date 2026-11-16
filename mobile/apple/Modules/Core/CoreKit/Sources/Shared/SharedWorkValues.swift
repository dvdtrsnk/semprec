@preconcurrency internal import SharedSDK

// MARK: - Kinds and states
extension ItemKind {

    init(_ kind: SharedSDK.ItemKind) {
        switch kind {
        case .task: self = .task
        case .event: self = .event
        }
    }

    var shared: SharedSDK.ItemKind {
        switch self {
        case .task: .task
        case .event: .event
        }
    }
}

// MARK: - Repeat
extension TaskRepeat {

    init(_ repeats: SharedSDK.TaskRepeat) {
        switch repeats {
        case .none: self = .never
        case .daily: self = .daily
        case .weekdays: self = .weekdays
        case .weekly: self = .weekly
        case .monthly: self = .monthly
        case .custom: self = .custom
        }
    }

    var shared: SharedSDK.TaskRepeat {
        switch self {
        case .never: .none
        case .daily: .daily
        case .weekdays: .weekdays
        case .weekly: .weekly
        case .monthly: .monthly
        case .custom: .custom
        }
    }
}

// MARK: - Link state
extension LinkState {

    init(_ state: SharedSDK.LinkState) {
        switch state {
        case .inherited: self = .inherited
        case .broken: self = .broken
        case .derived: self = .derived
        }
    }
}

// MARK: - Linked value
extension LinkedValue {

    var shared: SharedSDK.LinkedValue {
        switch self {
        case .project: .project
        case .people: .people
        }
    }
}

// MARK: - Tab
extension TasksTab {

    init(_ tab: SharedSDK.TasksTab) {
        switch tab {
        case .today: self = .today
        case .planned: self = .planned
        case .all: self = .all
        }
    }

    var shared: SharedSDK.TasksTab {
        switch self {
        case .today: .today
        case .planned: .planned
        case .all: .all
        }
    }
}

// MARK: - Section kind
extension TaskSectionKind {

    init(_ kind: SharedSDK.TaskSectionKind) {
        switch kind {
        case .late: self = .late
        case .today: self = .today
        case .tomorrow: self = .tomorrow
        case .week: self = .week
        case .later: self = .later
        case .none: self = .noDate
        }
    }
}

// MARK: - Things items point at
extension EntityRef {

    init(_ ref: SharedSDK.EntityRef) {
        self.init(id: ref.id, title: ref.title, color: ref.color)
    }
}

// MARK: - Project
extension ProjectRef {

    init(_ ref: SharedSDK.ProjectRef) {
        self.init(id: ref.id, title: ref.title, color: ref.color, areaId: ref.areaId, areaTitle: ref.areaTitle)
    }
}

// MARK: - Link
extension ValueLink {

    init(_ link: SharedSDK.ValueLink) {
        self.init(state: LinkState(link.state), sourceTitle: link.sourceTitle, brokenBySemp: link.brokenBySemp)
    }
}
