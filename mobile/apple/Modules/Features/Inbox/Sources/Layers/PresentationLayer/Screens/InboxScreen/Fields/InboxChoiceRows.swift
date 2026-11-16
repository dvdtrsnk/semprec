import CoreKit
import DesignSystem
import SwiftUI

/// A list of choices of which exactly one is picked: the event a recording belongs to, the person a speaker is.
struct InboxChoiceList: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            if field.options.isEmpty {
                Text("inbox.choice.none", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .padding(Theme.Spacing.medium)
            }
            ForEach(Array(field.options.enumerated()), id: \.element.identity) { index, option in
                if index > 0 { Divider().padding(.leading, Self.dividerInset) }
                Button {
                    send(.pick(cardId: cardId, key: field.key, choiceId: option.id))
                } label: {
                    row(option)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(option.selected ? .isSelected : [])
                .accessibilityIdentifier(InboxIdentifiers.optionPrefix + (option.id ?? "none"))
            }
        }
    }

    // MARK: - Private
    private static let dividerInset: CGFloat = 54

    private func row(_ option: InboxChoice) -> some View {
        HStack(spacing: 12) {
            Text(option.avatarInitials)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Color(hex: option.color) ?? .gray, in: .circle)
            VStack(alignment: .leading, spacing: 1) {
                Text(option.title(in: field.key))
                if let detail = detail(option) {
                    Text(detail).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: 0)
            if option.suggested {
                Image(systemName: "sparkles").font(.footnote).foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            if option.selected {
                Image(systemName: "checkmark").font(.body.bold()).foregroundStyle(Theme.Colors.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(minHeight: Theme.Layout.rowHeight)
        .contentShape(Rectangle())
    }

    /// The hint of a choice, or when and for how long an event is.
    private func detail(_ option: InboxChoice) -> String? {
        let start = InboxFormatting.time(option.timeFrom)
        let end = InboxFormatting.time(option.timeTo)
        let span = [start, end].compactMap { $0 }.joined(separator: "–")
        let spanText = span.isEmpty ? nil : span
        let when = [InboxFormatting.day(option.date), spanText].compactMap { $0 }.joined(separator: " ")
        let whenText = when.isEmpty ? nil : when
        return [whenText, option.hint].compactMap { $0 }.joined(separator: " · ").nilIfEmpty
    }
}

/// The type a capture becomes, as a grid of tiles; or, for the file of a file card, the name of the file.
struct InboxTileRow: View {

    // MARK: - Dependencies
    let cardId: String
    let field: InboxField
    let send: (InboxAction) -> Void

    // MARK: - Body
    var body: some View {
        if field.options.isEmpty {
            InboxRowFrame(field: field) {
                Text(field.selected.first?.label ?? "").lineLimit(1)
            }
        } else {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.small) {
                ForEach(field.options, id: \.identity) { option in tile(option) }
            }
            .padding(Theme.Spacing.small)
        }
    }

    // MARK: - Private
    private func tile(_ option: InboxChoice) -> some View {
        Button {
            send(.pick(cardId: cardId, key: field.key, choiceId: option.id))
        } label: {
            HStack(spacing: 10) {
                Text(option.initials ?? "").font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(option.label).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let hint = option.hint {
                        Text(hint).font(.caption2).foregroundStyle(Theme.Colors.secondaryText).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 54)
            .background(
                option.selected ? Theme.Colors.accent.opacity(0.08) : Color.gray.opacity(0.08),
                in: .rect(cornerRadius: 14)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14).stroke(option.selected ? Theme.Colors.accent : .clear, lineWidth: 2)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(option.selected ? .isSelected : [])
        .accessibilityIdentifier(InboxIdentifiers.optionPrefix + (option.id ?? "none"))
    }
}

// MARK: - String
private extension String {

    var nilIfEmpty: String? { isEmpty ? nil : self }
}
