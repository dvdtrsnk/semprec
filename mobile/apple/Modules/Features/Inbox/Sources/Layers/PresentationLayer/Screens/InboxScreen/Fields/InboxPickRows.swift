import CoreKit
import DesignSystem
import SwiftUI

/// One value picked from a list. The list opens over the card; the row shows what is picked now.
struct InboxSelectRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            Button {
                send(.openPicker(cardId: cardId, key: field.key))
            } label: {
                HStack(spacing: 6) {
                    if let choice = field.selected.first {
                        if let color = Color(hex: choice.color) {
                            Circle().fill(color).frame(width: 10, height: 10).accessibilityHidden(true)
                        }
                        Text(choice.title(in: field.key)).lineLimit(1)
                        if choice.isNew {
                            Text("inbox.new", bundle: .module).font(.caption2.bold()).foregroundStyle(.green)
                        }
                    } else {
                        Text("inbox.pick", bundle: .module).foregroundStyle(Theme.Colors.accent)
                    }
                    Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.tertiary)
                }
                .foregroundStyle(field.missing ? Theme.Colors.destructive : Color.primary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// Several values picked from a list: each is a chip that can be removed, and a button adds another.
struct InboxMultiRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            HStack(spacing: 6) {
                ForEach(field.selected, id: \.identity) { choice in chip(choice) }
                Button {
                    send(.openPicker(cardId: cardId, key: field.key))
                } label: {
                    Image(systemName: "plus")
                        .font(.footnote.bold())
                        .frame(width: 28, height: 28)
                        .background(Theme.Colors.accent.opacity(0.1), in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("inbox.add", bundle: .module))
            }
        }
    }
}

// MARK: - Private
private extension InboxMultiRow {

    func chip(_ choice: InboxChoice) -> some View {
        HStack(spacing: 4) {
            if choice.initials != nil {
                Text(choice.avatarInitials).font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 20, height: 20).background(Color(hex: choice.color) ?? .gray, in: .circle)
            } else if let color = Color(hex: choice.color) {
                Circle().fill(color).frame(width: 8, height: 8).padding(.leading, 4)
            }
            Text(choice.title(in: field.key)).font(.subheadline)
            if let id = choice.id {
                Button {
                    send(.toggle(cardId: cardId, key: field.key, choiceId: id))
                } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("inbox.remove", bundle: .module))
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 28)
        .background(Color.gray.opacity(0.12), in: .capsule)
    }
}

/// A switch.
struct InboxToggleRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        Toggle(isOn: Binding(get: { field.flag }, set: { send(.setFlag(cardId: cardId, key: field.key, value: $0)) })) {
            HStack(spacing: 6) {
                Text(field.title)
                if field.edited {
                    Circle().fill(Theme.Colors.accent).frame(width: 6, height: 6)
                        .accessibilityLabel(Text("inbox.edited", bundle: .module))
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: Theme.Layout.rowHeight)
    }
}

/// One of a few values, in a segmented control.
struct InboxSegRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            Picker(field.title, selection: selection) {
                ForEach(field.options, id: \.identity) { option in
                    Text(option.title(in: field.key)).tag(option.id)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: Self.maxWidth)
        }
    }

    // MARK: - Private
    private static let maxWidth: CGFloat = 220

    private var selection: Binding<String?> {
        Binding(
            get: { field.options.first(where: \.selected)?.id },
            set: { send(.pick(cardId: cardId, key: field.key, choiceId: $0)) }
        )
    }
}

/// One of a few colors.
struct InboxColorRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        InboxRowFrame(field: field) {
            HStack(spacing: Theme.Spacing.small) {
                ForEach(field.options, id: \.identity) { option in
                    Button {
                        send(.pick(cardId: cardId, key: field.key, choiceId: option.id))
                    } label: {
                        Circle()
                            .fill(Color(hex: option.color) ?? .gray)
                            .frame(width: 24, height: 24)
                            .overlay { if option.selected { Circle().stroke(Color.primary, lineWidth: 2).padding(-4) } }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(option.title(in: field.key)))
                    .accessibilityAddTraits(option.selected ? .isSelected : [])
                }
            }
        }
    }
}

/// A sentence that explains a field, with no control.
struct InboxInfoRow: View {

    // MARK: - Dependencies
    let field: InboxField

    // MARK: - Body
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.small) {
            Image(systemName: "info.circle").font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
            Text(field.info ?? field.title).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
