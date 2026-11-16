import CoreKit
import Foundation
import SwiftUI

/// The rows of each card of the overview, from the loaded content.
enum OverviewRows {

    // MARK: - Main
    static func main(_ content: OverviewContent) -> [OverviewRow] {
        communication(content) + planning(content)
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

    private static func planning(_ content: OverviewContent) -> [OverviewRow] {
        [
            OverviewRow(
                id: "journal",
                symbol: "book",
                tile: .tile("#FF9500"),
                title: Text("overview.row.journal", bundle: .module),
                trailing: .today,
                target: .journal(itemId: content.journalTodayItemId),
                identifier: OverviewIdentifiers.rowPrefix + "journal"
            ),
            OverviewRow(
                id: "tasks",
                symbol: "checkmark.circle",
                tile: .tile("#007AFF"),
                title: Text("overview.row.tasks", bundle: .module),
                trailing: .count(content.tasksToday),
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

    // MARK: - Areas
    static func areas(_ content: OverviewContent) -> [OverviewRow] {
        content.areas.map { area in
            OverviewRow(
                id: area.id,
                symbol: OverviewSymbols.area(icon: area.icon),
                tile: .tile(area.color, fallback: .indigo),
                title: Text(verbatim: area.name),
                trailing: area.activeProjectCount > 0 ? .count(area.activeProjectCount) : .none,
                target: .area(id: area.id),
                identifier: OverviewIdentifiers.areaPrefix + area.id
            )
        }
    }

    // MARK: - Projects
    static func projects(_ content: OverviewContent) -> [OverviewRow] {
        content.projects.map { project in
            OverviewRow(
                id: project.id,
                symbol: OverviewSymbols.projectFallback,
                tile: .tile(project.color, fallback: .purple),
                title: Text(verbatim: project.name),
                subtitle: subtitle(of: project).map { Text(verbatim: $0) },
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
                trailing: .count(collection.itemCount),
                target: .collection(ownerModuleId: collection.ownerModuleId, databaseId: collection.databaseId),
                identifier: OverviewIdentifiers.collectionPrefix + collection.ownerModuleId
            )
        }
    }

    // MARK: - Words
    /// "Work · In progress": the area of a project and its status, whichever the server tells.
    static func subtitle(of project: OverviewProject) -> String? {
        let parts = [project.areaName, status(project.status)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

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
