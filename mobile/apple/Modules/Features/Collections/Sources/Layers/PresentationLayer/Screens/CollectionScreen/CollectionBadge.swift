import SwiftUI

/// The mark of an item in a list or a tile: its initials (or the type of a file) on a tint, round for people and
/// projects and a rounded square for everything else.
struct CollectionBadge: View {

    // MARK: - Dependencies
    let title: String
    let tint: Color
    let isRound: Bool
    var label: String?
    var size: CGFloat = 34

    // MARK: - Body
    var body: some View {
        ZStack {
            shape.fill(tint.opacity(0.16))
            Text(label ?? initials)
                .font(.system(size: size * (label == nil ? 0.38 : 0.28), weight: .semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.horizontal, 2)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Subviews
private extension CollectionBadge {

    var shape: AnyShape {
        isRound ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
    }

    /// The first letters of the first two words of the title.
    var initials: String {
        title.split(separator: " ").prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
    }
}

// MARK: - Preview
#Preview {
    HStack {
        CollectionBadge(title: "Petr Novák", tint: .blue, isRound: true)
        CollectionBadge(title: "Faktura.pdf", tint: .red, isRound: false, label: "PDF")
    }
    .padding()
}
