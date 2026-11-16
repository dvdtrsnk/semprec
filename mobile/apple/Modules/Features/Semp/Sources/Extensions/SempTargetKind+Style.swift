import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Style
extension SempTargetKind {

    /// The SF Symbol of this kind of object.
    var symbol: String {
        switch self {
        case .task: "checkmark.circle"
        case .event: "calendar"
        case .mail: "envelope"
        case .inbox: "tray"
        case .journal: "book"
        case .project: "folder"
        case .area: "house"
        case .person: "person"
        case .company: "building.2"
        case .file: "doc"
        case .note: "doc.text"
        case .recording: "mic"
        case .finance: "creditcard"
        case .health: "heart"
        case .recipe: "fork.knife"
        case .book: "book.closed"
        case .movie: "film"
        case .run: "bolt"
        case .other: "circle"
        }
    }

    var color: Color {
        switch self {
        case .task: Theme.Colors.SempKind.task
        case .event: Theme.Colors.SempKind.event
        case .mail: Theme.Colors.SempKind.mail
        case .inbox: Theme.Colors.SempKind.inbox
        case .journal: Theme.Colors.SempKind.journal
        case .project: Theme.Colors.SempKind.project
        case .area: Theme.Colors.SempKind.area
        case .person: Theme.Colors.SempKind.person
        case .company: Theme.Colors.SempKind.company
        case .file: Theme.Colors.SempKind.file
        case .note: Theme.Colors.SempKind.note
        case .recording: Theme.Colors.SempKind.recording
        case .finance: Theme.Colors.SempKind.finance
        case .health: Theme.Colors.SempKind.health
        case .recipe: Theme.Colors.SempKind.recipe
        case .book: Theme.Colors.SempKind.book
        case .movie: Theme.Colors.SempKind.movie
        case .run: Theme.Colors.SempKind.run
        case .other: Theme.Colors.SempKind.other
        }
    }

    /// What this kind of object is called, for the accessibility label of a chip.
    var name: String {
        switch self {
        case .task: String(localized: "semp.kind.task", bundle: .module)
        case .event: String(localized: "semp.kind.event", bundle: .module)
        case .mail: String(localized: "semp.kind.mail", bundle: .module)
        case .inbox: String(localized: "semp.kind.inbox", bundle: .module)
        case .journal: String(localized: "semp.kind.journal", bundle: .module)
        case .project: String(localized: "semp.kind.project", bundle: .module)
        case .area: String(localized: "semp.kind.area", bundle: .module)
        case .person: String(localized: "semp.kind.person", bundle: .module)
        case .company: String(localized: "semp.kind.company", bundle: .module)
        case .file: String(localized: "semp.kind.file", bundle: .module)
        case .note: String(localized: "semp.kind.note", bundle: .module)
        case .recording: String(localized: "semp.kind.recording", bundle: .module)
        case .finance: String(localized: "semp.kind.finance", bundle: .module)
        case .health: String(localized: "semp.kind.health", bundle: .module)
        case .recipe: String(localized: "semp.kind.recipe", bundle: .module)
        case .book: String(localized: "semp.kind.book", bundle: .module)
        case .movie: String(localized: "semp.kind.movie", bundle: .module)
        case .run: String(localized: "semp.kind.run", bundle: .module)
        case .other: String(localized: "semp.kind.other", bundle: .module)
        }
    }

    /// What this kind of object is called after "with", for the hint of the field a message about it is written in.
    var nameWith: String {
        switch self {
        case .task: String(localized: "semp.kind.task.with", bundle: .module)
        case .event: String(localized: "semp.kind.event.with", bundle: .module)
        case .mail: String(localized: "semp.kind.mail.with", bundle: .module)
        case .inbox: String(localized: "semp.kind.inbox.with", bundle: .module)
        case .journal: String(localized: "semp.kind.journal.with", bundle: .module)
        case .project: String(localized: "semp.kind.project.with", bundle: .module)
        case .area: String(localized: "semp.kind.area.with", bundle: .module)
        case .person: String(localized: "semp.kind.person.with", bundle: .module)
        case .company: String(localized: "semp.kind.company.with", bundle: .module)
        case .file: String(localized: "semp.kind.file.with", bundle: .module)
        case .note: String(localized: "semp.kind.note.with", bundle: .module)
        case .recording: String(localized: "semp.kind.recording.with", bundle: .module)
        case .finance: String(localized: "semp.kind.finance.with", bundle: .module)
        case .health: String(localized: "semp.kind.health.with", bundle: .module)
        case .recipe: String(localized: "semp.kind.recipe.with", bundle: .module)
        case .book: String(localized: "semp.kind.book.with", bundle: .module)
        case .movie: String(localized: "semp.kind.movie.with", bundle: .module)
        case .run: String(localized: "semp.kind.run.with", bundle: .module)
        case .other: String(localized: "semp.kind.other.with", bundle: .module)
        }
    }
}
