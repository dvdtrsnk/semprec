import DesignSystem
import SwiftUI

// MARK: - Cards
extension JournalPageView {

    func section<Content: View>(
        _ title: Text,
        count: Int? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        section(title, count: count, trailing: { EmptyView() }, content: content)
    }

    /// A card of the day, as in the design: its heading with a count and an action inside the card, then its rows.
    func section<Trailing: View, Content: View>(
        _ title: Text,
        count: Int? = nil,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
            HStack(spacing: Theme.Spacing.small) {
                title.font(.title2.weight(.bold)).tracking(-0.3)
                if let count {
                    Text(String(count))
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(Theme.Colors.secondaryText.opacity(0.14), in: .capsule)
                }
                Spacer(minLength: 0)
                trailing()
            }
            content()
        }
        .padding(.horizontal, Theme.Spacing.medium + 4)
        .padding(.vertical, Theme.Spacing.medium + 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .journalCard()
    }

    func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) { content() }
            .padding(Theme.Spacing.medium + 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .journalCard()
    }

    /// The line between two rows of a card, from under the rows' text to the card's edge.
    var rowDivider: some View {
        Divider().padding(.leading, 26).padding(.trailing, -(Theme.Spacing.medium + 4))
    }
}
