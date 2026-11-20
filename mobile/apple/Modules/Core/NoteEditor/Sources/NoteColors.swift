import CoreKit
import SwiftUI

// MARK: - Palette
/// The palette's colours as the editor draws them: system colours, which adapt to the light and the dark appearance.
extension NoteEditorColor {

    /// The colour of text in this colour.
    var text: Color {
        switch self {
        case .gray: .gray
        case .brown: .brown
        case .orange: .orange
        case .yellow: .yellow
        case .green: .green
        case .blue: .blue
        case .purple: .purple
        case .pink: .pink
        case .red: .red
        }
    }

    /// The colour behind text highlighted in this colour.
    var highlight: Color { text.opacity(0.28) }

    /// The palette colour text is drawn in, if it is one.
    init?(text color: Color?) {
        guard let match = Self.allCases.first(where: { $0.text == color }) else { return nil }
        self = match
    }

    /// The palette colour text is highlighted in, if it is one.
    init?(highlight color: Color?) {
        guard let match = Self.allCases.first(where: { $0.highlight == color }) else { return nil }
        self = match
    }

    var title: LocalizedStringKey {
        switch self {
        case .gray: "noteEditor.color.gray"
        case .brown: "noteEditor.color.brown"
        case .orange: "noteEditor.color.orange"
        case .yellow: "noteEditor.color.yellow"
        case .green: "noteEditor.color.green"
        case .blue: "noteEditor.color.blue"
        case .purple: "noteEditor.color.purple"
        case .pink: "noteEditor.color.pink"
        case .red: "noteEditor.color.red"
        }
    }
}
