import Foundation

// The vocabulary of tasks and events that the Tasks screen and the Podrobnosti sheet share.

/// What a Podrobnosti sheet shows: a task, or an event of the calendar.
public enum ItemKind: Equatable, Hashable, Sendable {

    case task
    case event
}

/// How a task repeats; `custom` is a rule the app shows but does not edit.
public enum TaskRepeat: Equatable, Hashable, Sendable, CaseIterable {

    case never
    case daily
    case weekdays
    case weekly
    case monthly
    case custom
}

/// How a value of an item is tied to its source: followed, followed once and since changed, or always computed.
public enum LinkState: Equatable, Sendable {

    case inherited
    case broken
    case derived
}

/// The values of an item that can follow another item.
public enum LinkedValue: Equatable, Sendable {

    case project
    case people
}

/// A thing an item points at: a person, a file, an event, a company. `color` is a `#RRGGBB` string when it has one.
public struct EntityRef: Equatable, Hashable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let color: String?

    public init(id: String, title: String, color: String? = nil) {
        self.id = id
        self.title = title
        self.color = color
    }
}

/// A project a task or an event can be tied to.
public struct ProjectRef: Equatable, Hashable, Sendable, Identifiable {

    public let id: String
    public let title: String
    public let color: String?

    public init(id: String, title: String, color: String? = nil) {
        self.id = id
        self.title = title
        self.color = color
    }
}

/// Where a followed value comes from and, once broken, whether Semp broke it.
public struct ValueLink: Equatable, Sendable {

    public let state: LinkState
    public let sourceTitle: String?
    public let brokenBySemp: Bool

    public init(state: LinkState, sourceTitle: String? = nil, brokenBySemp: Bool = false) {
        self.state = state
        self.sourceTitle = sourceTitle
        self.brokenBySemp = brokenBySemp
    }
}
