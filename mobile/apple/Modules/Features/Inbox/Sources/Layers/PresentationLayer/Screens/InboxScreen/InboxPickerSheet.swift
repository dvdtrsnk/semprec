import CoreKit
import DesignSystem
import SwiftUI

/// The items a select or a multi-value field offers, over the card. A single pick closes it; a multi-value one stays
/// open until it is done. A list that could not be read says so and can be asked for again.
struct InboxPickerSheet: View {

    // MARK: - Dependencies
    let picker: InboxPicker
    let card: InboxCard?
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { send(.closePicker) } label: { Text("inbox.done", bundle: .module) }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(InboxIdentifiers.picker)
    }
}

// MARK: - Subviews
private extension InboxPickerSheet {

    var title: String {
        card?.groups.flatMap(\.fields).first { $0.key == picker.key }?.title ?? ""
    }

    @ViewBuilder var content: some View {
        switch picker.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(.failure(message: Text("inbox.picker.failed", bundle: .module)) {
                send(.openPicker(cardId: picker.cardId, key: picker.key))
            })
        case .ready:
            List(picker.options, id: \.identity) { option in
                Button {
                    choose(option)
                } label: {
                    row(option)
                }
                .disabled(option.disabled)
                .listRowButton()
                .accessibilityAddTraits(option.selected ? .isSelected : [])
                .accessibilityIdentifier(InboxIdentifiers.optionPrefix + (option.id ?? "none"))
            }
        }
    }

    func row(_ option: InboxChoice) -> some View {
        HStack(spacing: 12) {
            if let color = Color(hex: option.color) {
                Circle().fill(color).frame(width: 12, height: 12).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(option.title(in: picker.key))
                    .foregroundStyle(option.disabled ? Theme.Colors.secondaryText : Color.primary)
                if let hint = option.hint {
                    Text(hint).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: 0)
            if option.suggested {
                Image(systemName: "sparkles").font(.footnote).foregroundStyle(.tertiary).accessibilityHidden(true)
            }
            if option.selected {
                Image(systemName: "checkmark").font(.body.bold()).foregroundStyle(Theme.Colors.accent)
            }
        }
        .contentShape(Rectangle())
    }

    func choose(_ option: InboxChoice) {
        if picker.multi, let id = option.id {
            send(.toggle(cardId: picker.cardId, key: picker.key, choiceId: id))
        } else {
            send(.pick(cardId: picker.cardId, key: picker.key, choiceId: option.id))
        }
    }
}
