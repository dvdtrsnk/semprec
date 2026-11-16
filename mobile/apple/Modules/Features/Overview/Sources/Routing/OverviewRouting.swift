import CoreKit

/// What a picked search result stands for, as plain values: the app decides which screen shows it.
public struct SearchResultLink: Equatable, Sendable {

    public let type: SearchGroupType
    public let itemId: String?
    public let threadId: String?
    public let databaseKey: String?
    /// The period type (`day`, `week`, ...) and key of a journal result.
    public let journalType: String?
    public let journalPeriod: String?

    public init(
        type: SearchGroupType,
        itemId: String?,
        threadId: String?,
        databaseKey: String?,
        journalType: String?,
        journalPeriod: String?
    ) {
        self.type = type
        self.itemId = itemId
        self.threadId = threadId
        self.databaseKey = databaseKey
        self.journalType = journalType
        self.journalPeriod = journalPeriod
    }
}

/// How the Overview feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol OverviewRouting: AnyObject {

    /// The person opened a row of the overview, or the profile button.
    func show(_ target: OverviewTarget)

    /// The person picked a search result.
    func showSearchResult(_ link: SearchResultLink)
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewOverviewRouter: OverviewRouting {

    // MARK: - Protocol conformance
    func show(_ target: OverviewTarget) {}

    func showSearchResult(_ link: SearchResultLink) {}
}
