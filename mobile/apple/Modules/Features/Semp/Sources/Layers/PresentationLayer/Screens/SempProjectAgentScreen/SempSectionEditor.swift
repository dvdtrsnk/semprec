import CoreKit
import DesignSystem
import SwiftUI

/// One part of the project's instructions. The text is edited here and sent to Kotlin when the person leaves the field,
/// so a save is one write of the whole instructions; a text the server changed meanwhile replaces the draft.
struct SempSectionEditor: View {

    // MARK: - Dependencies
    let section: SempSection
    /// The text the server holds.
    let text: String
    let save: (String) -> Void

    // MARK: - Properties
    @State private var draft: String
    @FocusState private var focused: Bool

    // MARK: - Init
    init(section: SempSection, text: String, save: @escaping (String) -> Void) {
        self.section = section
        self.text = text
        self.save = save
        _draft = State(initialValue: text)
    }

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 8, height: 8)
                title.font(.subheadline.weight(.semibold))
            }
            TextEditor(text: $draft)
                .focused($focused)
                .frame(minHeight: 70)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topLeading) {
                    if draft.isEmpty {
                        placeholder.foregroundStyle(.tertiary).padding(12).allowsHitTesting(false)
                    }
                }
                .accessibilityIdentifier(SempIdentifiers.sectionPrefix + name)
        }
        .onChange(of: focused) { _, isFocused in
            if !isFocused, draft != text { save(draft) }
        }
        .onChange(of: text) { _, newText in
            if !focused { draft = newText }
        }
        .onDisappear {
            if draft != text { save(draft) }
        }
    }
}

// MARK: - Subviews
private extension SempSectionEditor {

    var name: String {
        switch section {
        case .purpose: "purpose"
        case .allowed: "allowed"
        case .notAllowed: "notAllowed"
        case .general: "general"
        }
    }

    var color: Color {
        switch section {
        case .purpose: Theme.Colors.accent
        case .allowed: Theme.Colors.sempSuccess
        case .notAllowed: Theme.Colors.destructive
        case .general: Theme.Colors.secondaryText
        }
    }

    var title: Text {
        switch section {
        case .purpose: Text("semp.agent.section.purpose", bundle: .module)
        case .allowed: Text("semp.agent.section.allowed", bundle: .module)
        case .notAllowed: Text("semp.agent.section.notAllowed", bundle: .module)
        case .general: Text("semp.agent.section.general", bundle: .module)
        }
    }

    var placeholder: Text {
        switch section {
        case .purpose: Text("semp.agent.placeholder.purpose", bundle: .module)
        case .allowed: Text("semp.agent.placeholder.allowed", bundle: .module)
        case .notAllowed: Text("semp.agent.placeholder.notAllowed", bundle: .module)
        case .general: Text("semp.agent.placeholder.general", bundle: .module)
        }
    }
}
