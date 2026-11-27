import SwiftUI

/// A filter as a capsule: a color dot, its title and an accessory after it, such as a count or a button that removes
/// the filter. A selected chip is filled with its color and carries the selected trait.
public struct FilterChip<Accessory: View>: View {

    // MARK: - Dependencies
    private let title: String
    private let color: Color
    private let isSelected: Bool
    private let accessory: Accessory

    // MARK: - Init
    public init(title: String, color: Color, isSelected: Bool = false, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.color = color
        self.isSelected = isSelected
        self.accessory = accessory()
    }

    // MARK: - Body
    public var body: some View {
        HStack(spacing: Theme.Spacing.small / 2) {
            Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(title).font(.footnote).lineLimit(1)
            accessory
        }
        .padding(.horizontal, Theme.Spacing.small)
        .padding(.vertical, 6)
        .background(background, in: Capsule())
        .overlay { if isSelected { Capsule().strokeBorder(color, lineWidth: 1) } }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Subviews
private extension FilterChip {

    var background: AnyShapeStyle {
        isSelected ? AnyShapeStyle(color.opacity(Theme.Opacity.selectedFill)) : AnyShapeStyle(.regularMaterial)
    }
}

// MARK: - Preview
#Preview {
    HStack {
        FilterChip(title: "Client", color: .orange, isSelected: true) { Text("3").font(.caption) }
        FilterChip(title: "Home", color: .blue) { Text("1").font(.caption) }
    }
    .padding()
}
