import CoreKit
import DesignSystem
import SwiftUI

/// The items another item points at, as chips that open them, with a menu to take one away and a button that opens
/// the picker for another.
struct RelationValueView: View {

    // MARK: - Dependencies
    let field: FieldView
    let send: (ItemAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: 6) {
            if case .targets(let targets) = field.content {
                TargetChips(targets: targets, open: open, remove: remove)
            }
            Button { send(.picker(.open(propertyKey: field.propertyKey))) } label: {
                Image(systemName: "plus.circle.fill").foregroundStyle(Theme.Colors.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("relation.add", bundle: .module))
        }
    }
}

// MARK: - Actions
private extension RelationValueView {

    func open(_ target: FieldTarget) {
        send(.navigate(.openTarget(id: target.id, databaseKey: target.databaseKey)))
    }

    func remove(_ target: FieldTarget) {
        send(.edit(.removeTarget(propertyKey: field.propertyKey, targetId: target.id)))
    }
}

/// Chips of the items a relation holds. A tap opens one; with `remove`, a long press offers to take it away.
struct TargetChips: View {

    // MARK: - Dependencies
    let targets: [FieldTarget]
    let open: (FieldTarget) -> Void
    var remove: ((FieldTarget) -> Void)?

    // MARK: - Body
    var body: some View {
        if targets.isEmpty {
            Text("field.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
        } else {
            WrappingChips {
                ForEach(targets, id: \.id) { target in
                    chip(target)
                }
            }
        }
    }
}

// MARK: - Subviews
private extension TargetChips {

    func chip(_ target: FieldTarget) -> some View {
        let tint = Color(hex: target.color) ?? Theme.Colors.accent
        return Button { open(target) } label: {
            Text(target.title)
                .font(.subheadline)
                .foregroundStyle(tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(tint.opacity(0.14), in: Capsule())
                .lineLimit(1)
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let remove {
                Button(role: .destructive) { remove(target) } label: {
                    Label { Text("relation.remove", bundle: .module) } icon: { Image(systemName: "minus.circle") }
                }
            }
        }
    }
}

/// Lays chips out in a row that wraps onto more rows when they do not fit, leading-aligned.
struct WrappingChips: Layout {

    // MARK: - Properties
    private let spacing: CGFloat = 6

    // MARK: - Layout
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arranged = arrange(width: bounds.width, subviews: subviews)
        for (subview, origin) in zip(subviews, arranged.origins) {
            subview.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }
}

// MARK: - Arrangement
private extension WrappingChips {

    func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var left: CGFloat = 0
        var top: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if left > 0, left + size.width > width {
                left = 0
                top += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: left, y: top))
            left += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, left - spacing)
        }
        return (CGSize(width: widest, height: top + rowHeight), origins)
    }
}
