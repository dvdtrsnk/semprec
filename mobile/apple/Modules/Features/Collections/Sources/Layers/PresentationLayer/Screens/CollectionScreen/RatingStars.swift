import DesignSystem
import SwiftUI

/// The stars a person gave a book, a film or a recipe: five stars, as many filled as the rating, read out as a number.
struct RatingStars: View {

    // MARK: - Properties
    static let maximum = 5

    // MARK: - Dependencies
    let rating: Int

    // MARK: - Body
    var body: some View {
        HStack(spacing: 1) {
            ForEach(1...Self.maximum, id: \.self) { star in
                Image(systemName: star <= rating ? "star.fill" : "star")
                    .font(.caption2)
                    .foregroundStyle(star <= rating ? Color.orange : Theme.Colors.secondaryText.opacity(0.5))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(Self.label(rating)))
    }
}

// MARK: - Words
extension RatingStars {

    /// "4 of 5 stars", read out by the accessibility label.
    static func label(_ rating: Int) -> String {
        String(format: String(localized: "collection.rating", bundle: .module), rating, maximum)
    }
}

// MARK: - Preview
#Preview {
    VStack {
        RatingStars(rating: 4)
        RatingStars(rating: 1)
    }
    .padding()
}
