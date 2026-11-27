import CoreKit
import DesignSystem
import SwiftUI

/// One match of the search: the symbol of its kind, its title, the subtitle the server's pieces make and, when the
/// match was found in the text of the item, an excerpt of it.
struct SearchResultRow: View {

    // MARK: - Dependencies
    let result: SearchResult
    let type: SearchGroupType

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.medium - 2) {
            Image(systemName: OverviewSymbols.searchGroup(type))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(tile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: result.title).font(.body).foregroundStyle(.primary)
                if !subtitle.isEmpty {
                    Text(verbatim: subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
                if let snippet = result.snippet, !snippet.isEmpty {
                    Text(verbatim: snippet)
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: Theme.Spacing.small)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small)
        .frame(minHeight: Theme.Layout.rowHeight + 2)
        .contentShape(Rectangle())
    }

    // MARK: - Content
    private var subtitle: String {
        SearchSubtitle(date: DisplayDate(now: .now)).text(for: result.subtitle)
    }

    private var tile: Color {
        switch type {
        case .task: .blue
        case .event: .red
        case .project: .purple
        case .contact: .teal
        case .journal: .orange
        case .file: .gray
        case .mail: .blue
        case .chat: .black
        }
    }
}
