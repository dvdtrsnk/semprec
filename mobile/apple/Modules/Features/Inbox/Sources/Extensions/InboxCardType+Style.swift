import CoreKit
import SwiftUI

// MARK: - Style
extension InboxCardType {

    /// The SF Symbol of the card's chip.
    var symbol: String {
        switch self {
        case .task: "checkmark.circle"
        case .event: "calendar"
        case .page: "doc.text"
        case .journal: "book.closed"
        case .project: "folder"
        case .area: "house"
        case .company: "building.2"
        case .person: "person"
        case .health: "heart"
        case .file: "doc"
        case .recording: "mic"
        case .mcp: "powerplug"
        case .invalid: "exclamationmark.triangle"
        case .clarify: "questionmark"
        case .transcriptEvent: "waveform"
        case .speaker: "person.wave.2"
        case .approval: "checkmark.shield"
        case .unsupported: "questionmark.square.dashed"
        }
    }

    /// The color of the card's chip.
    var tint: Color {
        switch self {
        case .task: .blue
        case .event, .project, .transcriptEvent: .purple
        case .page, .journal, .mcp: .orange
        case .area, .approval: .indigo
        case .company, .file, .recording, .unsupported: .gray
        case .person, .speaker: .teal
        case .health: .pink
        case .invalid: .red
        case .clarify: .yellow
        }
    }

    /// The key of the chip's text in the String Catalog.
    var chipKey: String.LocalizationValue {
        switch self {
        case .task: "inbox.type.task"
        case .event: "inbox.type.event"
        case .page: "inbox.type.page"
        case .journal: "inbox.type.journal"
        case .project: "inbox.type.project"
        case .area: "inbox.type.area"
        case .company: "inbox.type.company"
        case .person: "inbox.type.person"
        case .health: "inbox.type.health"
        case .file: "inbox.type.file"
        case .recording: "inbox.type.recording"
        case .mcp: "inbox.type.mcp"
        case .invalid: "inbox.type.invalid"
        case .clarify: "inbox.type.clarify"
        case .transcriptEvent: "inbox.type.transcriptEvent"
        case .speaker: "inbox.type.speaker"
        case .approval: "inbox.type.approval"
        case .unsupported: "inbox.type.unsupported"
        }
    }

    /// The chip's text.
    var chipText: String { String(localized: chipKey, bundle: .module) }
}

// MARK: - Risk
extension InboxRiskLevel {

    var tint: Color {
        switch self {
        case .irreversible: .red
        case .outbound, .breaksLink: .orange
        case .write: .secondary
        }
    }

    var text: String {
        switch self {
        case .irreversible: String(localized: "inbox.risk.irreversible", bundle: .module)
        case .outbound: String(localized: "inbox.risk.outbound", bundle: .module)
        case .breaksLink: String(localized: "inbox.risk.breaksLink", bundle: .module)
        case .write: String(localized: "inbox.risk.write", bundle: .module)
        }
    }
}
