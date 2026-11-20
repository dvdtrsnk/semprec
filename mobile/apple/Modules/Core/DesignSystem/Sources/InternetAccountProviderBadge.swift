import SwiftUI

/// The letter and color of a provider, as the avatar of its accounts; `provider` is the stored key (`gmail`,
/// `outlook`, `icloud`, `imap`). The account screens and the calendars of the accounts show the same one.
public struct InternetAccountProviderBadge: View {

    // MARK: - Dependencies
    private let provider: String?
    private let size: CGFloat

    // MARK: - Init
    public init(provider: String?, size: CGFloat = 36) {
        self.provider = provider
        self.size = size
    }

    // MARK: - Body
    public var body: some View {
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
