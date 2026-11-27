import CoreKit
import Foundation
import SwiftUI

/// The rows of each card of the overview, from the loaded content. Only the Inbox and the mail count anything: what
/// waits for the person; the Journal has its own tab.
enum OverviewRows {

    // MARK: - Main
    static func main(_ content: OverviewContent) -> [OverviewRow] {
        communication(content) + planning()
    }

    private static func communication(_ content: OverviewContent) -> [OverviewRow] {
        [
            OverviewRow(
                id: "inbox",
                symbol: "tray",
                tile: .tile("#FF3B30"),
                title: Text("overview.row.inbox", bundle: .module),
                trailing: content.inboxPending > 0 ? .badge(content.inboxPending) : .none,
                target: .inbox,
                identifier: OverviewIdentifiers.rowPrefix + "inbox"
            ),
            OverviewRow(
                id: "mail",
                symbol: "envelope",
                tile: .tile("#1C6ED6"),
                title: Text("overview.row.mail", bundle: .module),
                trailing: content.mailUnread > 0 ? .count(content.mailUnread) : .none,
                target: .mail,
                identifier: OverviewIdentifiers.rowPrefix + "mail"
            ),
            OverviewRow(
                id: "recordings",
                symbol: "mic",
                tile: .tile("#1C1C1E"),
                title: Text("overview.row.recordings", bundle: .module),
                target: .recordings,
                identifier: OverviewIdentifiers.rowPrefix + "recordings"
            )
        ]
    }

    private static func planning() -> [OverviewRow] {
        [
            OverviewRow(
                id: "tasks",
                symbol: "checkmark.circle",
                tile: .tile("#007AFF"),
                title: Text("overview.row.tasks", bundle: .module),
                target: .tasks,
                identifier: OverviewIdentifiers.rowPrefix + "tasks"
            ),
            OverviewRow(
                id: "finance",
                symbol: "creditcard",
                tile: .tile("#34C759"),
                title: Text("overview.row.finance", bundle: .module),
                target: .finance,
                identifier: OverviewIdentifiers.rowPrefix + "finance"
            )
        ]
    }

    // MARK: - Projects
    static func projects(_ content: OverviewContent) -> [OverviewRow] {
        content.projects.map { project in
            OverviewRow(
                id: project.id,
                symbol: OverviewSymbols.projectFallback,
                tile: .tile(project.color, fallback: .purple),
                title: Text(verbatim: project.name),
                subtitle: status(project.status).map { Text(verbatim: $0) },
                target: .project(id: project.id),
                identifier: OverviewIdentifiers.projectPrefix + project.id
            )
        }
    }

    // MARK: - Collections
    static func collections(_ content: OverviewContent) -> [OverviewRow] {
        content.collections.map { collection in
            OverviewRow(
                id: collection.databaseId,
                symbol: OverviewSymbols.collection(icon: collection.icon, ownerModuleId: collection.ownerModuleId),
                tile: .tile(collection.color),
                title: Text(verbatim: collection.name),
                target: .collection(ownerModuleId: collection.ownerModuleId, databaseId: collection.databaseId),
                identifier: OverviewIdentifiers.collectionPrefix + collection.ownerModuleId
            )
        }
    }

    // MARK: - Words
    /// The words of a project's status, or nil for a status the app does not know.
    static func status(_ key: String?) -> String? {
        switch key {
        case "inProgress": String(localized: "overview.project.status.inProgress", bundle: .module)
        case "longTerm": String(localized: "overview.project.status.longTerm", bundle: .module)
        case "done": String(localized: "overview.project.status.done", bundle: .module)
        case "archived": String(localized: "overview.project.status.archived", bundle: .module)
        default: nil
        }
    }
}

// MARK: - Tile color
extension Color {

    /// The color of a row's tile: the stored `#RRGGBB` value, or `fallback` when there is none.
    static func tile(_ hex: String?, fallback: Color = .gray) -> Color {
        Color(hex: hex) ?? fallback
    }
}
