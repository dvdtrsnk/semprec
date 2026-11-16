import CoreKit
import DesignSystem
import SwiftUI

/// The field the person writes to Semp in: the objects staged for the message above it, the text and the send button.
/// The text stays here until it is sent; the Kotlin ViewModel then holds the message and its delivery.
struct SempComposerView: View {

    // MARK: - Dependencies
    let state: SempThreadState
    let send: (SempThreadAction) -> Void

    // MARK: - Properties
    @State private var draft = ""

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !state.attachments.isEmpty { attachments }
            HStack(spacing: 8) {
                TextField(text: $draft) { Text(placeholder) }
                    .textFieldStyle(.plain)
                    .submitLabel(.send)
                    .onSubmit(submit)
                    .accessibilityIdentifier(SempIdentifiers.composerField)
                Button(action: submit) {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? Theme.Colors.brand : Color.secondary.opacity(0.4))
                .disabled(!canSend)
                .accessibilityLabel(Text("semp.composer.send", bundle: .module))
                .accessibilityIdentifier(SempIdentifiers.send)
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: Capsule())
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.bottom, Theme.Spacing.small)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SempIdentifiers.composer)
    }
}

// MARK: - Subviews
private extension SempComposerView {

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !state.sending
    }

    func submit() {
        guard canSend else { return }
        send(.send(draft))
        draft = ""
    }

    var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(state.attachments) { attachment in
                    SempChipView(kind: attachment.kind, label: attachment.title) {
                        send(.removeAttachment(key: attachment.id))
                    }
                    .accessibilityIdentifier(SempIdentifiers.attachmentPrefix + attachment.id)
                }
            }
        }
    }

    var placeholder: String {
        switch state.type {
        case .item: String(localized: "semp.composer.placeholder.item", bundle: .module)
        case .tick: String(localized: "semp.composer.placeholder.tick", bundle: .module)
        case .chat:
            if let only = state.attachments.first, state.attachments.count == 1 {
                String(
                    format: String(localized: "semp.composer.placeholder.one", bundle: .module),
                    locale: .current,
                    only.kind.nameWith
                )
            } else if state.attachments.isEmpty {
                String(localized: "semp.composer.placeholder", bundle: .module)
            } else {
                String(localized: "semp.composer.placeholder.many", bundle: .module)
            }
        }
    }
}

#Preview {
    SempComposerView(state: SempThreadState(phase: .ready), send: { _ in })
}
