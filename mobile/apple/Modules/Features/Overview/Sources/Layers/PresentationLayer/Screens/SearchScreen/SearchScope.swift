import CoreKit
import SwiftUI

/// A chip of the search: all kinds, or one of them.
struct SearchScope: Identifiable {

    // MARK: - Properties
    let type: SearchGroupType?

    var id: String { identifier }

    /// The scopes in the order of the chips: everything first, then each kind in the server's order.
    static let all: [SearchScope] = [SearchScope(type: nil)] + SearchGroupType.allCases.map { SearchScope(type: $0) }

    // MARK: - Init
    init(type: SearchGroupType?) {
        self.type = type
    }

    // MARK: - Words
    var title: LocalizedStringKey {
        switch type {
        case nil: "search.scope.all"
        case .task: "search.scope.task"
        case .event: "search.scope.event"
        case .project: "search.scope.project"
        case .area: "search.scope.area"
        case .contact: "search.scope.contact"
        case .journal: "search.scope.journal"
        case .file: "search.scope.file"
        case .mail: "search.scope.mail"
        case .chat: "search.scope.chat"
        }
    }

    var identifier: String {
        switch type {
        case nil: "all"
        case .task: "task"
        case .event: "event"
        case .project: "project"
        case .area: "area"
        case .contact: "contact"
        case .journal: "journal"
        case .file: "file"
        case .mail: "mail"
        case .chat: "chat"
        }
    }
}
