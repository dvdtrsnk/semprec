import SwiftUI

/// The letter and color of a provider, as the avatar of its accounts; `provider` is the stored key.
struct InternetAccountProviderBadge: View {

    // MARK: - Dependencies
    let provider: String?
    var size: CGFloat = 36

    // MARK: - Body
    var body: some View {
        Text(verbatim: letter)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: Circle())
            .accessibilityHidden(true)
    }

    // MARK: - Private
    private var letter: String {
        switch provider {
        case "gmail": "G"
        case "outlook": "M"
        case "icloud": "i"
        default: "@"
        }
    }

    private var color: Color {
        switch provider {
        case "gmail": .red
        case "outlook": .blue
        case "icloud": .cyan
        default: .gray
        }
    }
}
