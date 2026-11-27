import Foundation

/// The kinds of result global search groups its answer by, in the order the server lists them.
public enum SearchGroupType: CaseIterable, Equatable, Sendable {

    case task
    case event
    case project
    case contact
    case journal
    case file
    case mail
    case chat
}

/// The kinds of piece a result's subtitle is made of; the feature composes the text of each.
public enum SearchSubtitleKind: Equatable, Sendable {

    case date
    case time
    case timeRange
    case place
    case recurrence
    case project
    case people
    case phone
    case relationship
    case status
    case count
    case sender
    case movedFrom
    case missedInEvent
}

/// One piece of a result's subtitle: its kind and the canonical value (a `YYYY-MM-DD` date, an `HH:mm` time,
/// `HH:mm-HH:mm` for a range, a stored key or a title).
public struct SearchSubtitlePart: Equatable, Sendable {

    public let kind: SearchSubtitleKind
    public let value: String
    public let itemId: String?

    public init(kind: SearchSubtitleKind, value: String, itemId: String?) {
        self.kind = kind
        self.value = value
        self.itemId = itemId
    }
}

/// One match. `key` identifies it within its group: the thread of a mail or chat match, the item of any other.
public struct SearchResult: Equatable, Sendable, Identifiable {

    public let key: String
    public let itemId: String?
    public let threadId: String?
    public let databaseKey: String?
    public let title: String
    public let subtitle: [SearchSubtitlePart]
    public let snippet: String?
    /// The period type (`day`, `week`, ...) and key of a journal match.
    public let journalType: String?
    public let journalPeriod: String?

    public var id: String { key }

    public init(
        key: String,
        itemId: String?,
        threadId: String?,
        databaseKey: String?,
        title: String,
        subtitle: [SearchSubtitlePart],
        snippet: String?,
        journalType: String?,
        journalPeriod: String?
    ) {
        self.key = key
        self.itemId = itemId
        self.threadId = threadId
        self.databaseKey = databaseKey
        self.title = title
        self.subtitle = subtitle
        self.snippet = snippet
        self.journalType = journalType
        self.journalPeriod = journalPeriod
    }
}

/// The matches of one kind; `total` counts every match, `results` are the ones listed.
public struct SearchGroup: Equatable, Sendable, Identifiable {

    public let type: SearchGroupType
    public let total: Int
    public let results: [SearchResult]

    public var id: SearchGroupType { type }

    public init(type: SearchGroupType, total: Int, results: [SearchResult]) {
        self.type = type
        self.total = total
        self.results = results
    }
}

public enum SearchPhase: Equatable, Sendable {

    /// No text yet: the recent searches show.
    case recents
    case searching
    case results
    /// The text matches nothing.
    case empty
    case failure(FailureKind?)
}

/// `scope` is the kind searched, nil for all. While `phase` is `.searching`, `groups` still holds the answer to the
/// earlier text.
public struct SearchState: Equatable, Sendable {

    public var phase: SearchPhase
    public var scope: SearchGroupType?
    public var recents: [String]
    public var groups: [SearchGroup]

    public init(
        phase: SearchPhase = .recents,
        scope: SearchGroupType? = nil,
        recents: [String] = [],
        groups: [SearchGroup] = []
    ) {
        self.phase = phase
        self.scope = scope
        self.recents = recents
        self.groups = groups
    }
}

public enum SearchAction: Equatable, Sendable {

    /// The text changed; it is searched once the person pauses typing.
    case queryChanged(String)
    case selectScope(SearchGroupType?)
    /// The person confirmed the text: it is remembered and searched at once.
    case submit(String)
    case retry
    case open(type: SearchGroupType, key: String)
}

public enum SearchEffect: Equatable, Sendable {

    /// The person picked a result; the app opens what it stands for.
    case openResult(
        type: SearchGroupType,
        itemId: String?,
        threadId: String?,
        databaseKey: String?,
        journalType: String?,
        journalPeriod: String?
    )
}

public typealias SearchScreenModel = ScreenModel<SearchState, SearchAction, SearchEffect>

/// Search screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSearchScreenModel = ScriptedScreenModel<SearchState, SearchAction, SearchEffect>
