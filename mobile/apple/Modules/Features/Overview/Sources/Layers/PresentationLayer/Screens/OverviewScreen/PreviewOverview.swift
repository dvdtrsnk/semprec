import CoreKit

/// Sample values for previews: the canonical task of the design and the areas, projects and collections around it.
enum PreviewOverview {

    // MARK: - Overview
    static let content = OverviewContent(
        accountEmail: "david.tresnak@example.cz",
        inboxPending: 9,
        mailUnread: 5,
        problemCount: 2,
        areas: [
            OverviewArea(id: "work", name: "Work", color: "#5856D6", icon: "briefcase"),
            OverviewArea(id: "health", name: "Health", color: "#FF2D55", icon: "heart")
        ],
        projects: [
            OverviewProject(id: "p1", name: "Semprec iOS", color: "#007AFF", areaName: "Work", status: "inProgress")
        ],
        collections: [
            OverviewCollection(
                databaseId: "d1", ownerModuleId: "events", name: "Events",
                icon: "calendar", color: "#FF3B30"
            ),
            OverviewCollection(
                databaseId: "d2", ownerModuleId: "people", name: "People",
                icon: "person", color: "#30B0C7"
            )
        ]
    )

    // MARK: - Search
    static let searchResults = SearchState(
        phase: .results,
        groups: [
            SearchGroup(
                type: .task,
                total: 6,
                results: [
                    SearchResult(
                        key: "t1",
                        itemId: "t1",
                        threadId: nil,
                        databaseKey: "tasks",
                        title: "Send the invoice",
                        subtitle: [
                            SearchSubtitlePart(kind: .date, value: "2026-10-16", itemId: nil),
                            SearchSubtitlePart(kind: .timeRange, value: "14:00-15:30", itemId: nil),
                            SearchSubtitlePart(kind: .project, value: "Accounting", itemId: "p1")
                        ],
                        snippet: nil,
                        journalType: nil,
                        journalPeriod: nil
                    )
                ]
            )
        ]
    )
}
