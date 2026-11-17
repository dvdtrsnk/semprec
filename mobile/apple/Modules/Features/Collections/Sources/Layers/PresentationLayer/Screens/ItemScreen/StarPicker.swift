import DesignSystem
import SwiftUI

/// Five stars the person taps to rate a book or a film; tapping the star of the current rating clears it. It is
/// adjustable with VoiceOver like a stepper.
struct StarPicker: View {

    // MARK: - Properties
    static let maximum = 5

    // MARK: - Dependencies
    let rating: Int
    let change: (Int?) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: 4) {
            ForEach(1...Self.maximum, id: \.self) { star in
                Button { change(star == rating ? nil : star) } label: {
                    Image(systemName: star <= rating ? "star.fill" : "star")
                        .foregroundStyle(star <= rating ? Color.orange : Theme.Colors.secondaryText)
                }
                .buttonStyle(.borderless)
            }
        }
        .font(.title3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("item.media.rating", bundle: .module))
        .accessibilityValue(Text(RatingStars.label(rating)))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: change(min(rating + 1, Self.maximum))
            case .decrement: change(rating > 1 ? rating - 1 : nil)
            @unknown default: break
            }
        }
    }
}

// MARK: - Preview
#Preview {
    StarPicker(rating: 3) { _ in }.padding()
}
