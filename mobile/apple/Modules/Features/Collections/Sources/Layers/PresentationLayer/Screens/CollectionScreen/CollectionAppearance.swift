import CoreKit
import SwiftUI

/// How the items of one collection are drawn: the tint of its database, whether its badges are round, and how its
/// values are worded.
struct CollectionAppearance {

    // MARK: - Properties
    let databaseKey: String?
    let color: String?
    var format = FieldFormat()

    // MARK: - Derived
    /// People and projects have round badges, everything else rounded squares.
    var isRound: Bool {
        databaseKey == DatabaseKey.people || databaseKey == DatabaseKey.projects
    }

    var baseTint: Color {
        Color(hex: color) ?? .accentColor
    }

    /// The tint of an item: its status color, else the database's.
    func tint(of row: CollectionRow) -> Color {
        Color(hex: row.group?.color) ?? baseTint
    }

    /// Files show their type in the badge instead of initials.
    func badgeLabel(of row: CollectionRow) -> String? {
        databaseKey == DatabaseKey.files ? row.fileType : nil
    }

    // MARK: - Semp
    /// What the Semp bubble receives when it is dropped on `row`.
    func sempTarget(of row: CollectionRow) -> SempTarget {
        let meta = format.subtitle(row.subtitle)
        return SempTarget(kind: sempKind, title: row.title, meta: meta.isEmpty ? nil : meta, itemId: row.id)
    }

    private var sempKind: SempTargetKind {
        switch databaseKey {
        case DatabaseKey.projects: .project
        case DatabaseKey.areas: .area
        case DatabaseKey.people: .person
        case DatabaseKey.companies: .company
        case DatabaseKey.events: .event
        case DatabaseKey.files: .file
        default: .other
        }
    }
}
