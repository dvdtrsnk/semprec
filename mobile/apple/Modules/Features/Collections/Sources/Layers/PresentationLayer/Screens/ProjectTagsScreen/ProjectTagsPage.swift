import CoreKit
import DesignSystem
import SwiftUI

/// Every tag of the projects, each opening, through `open`, the screen that renames, recolors or deletes it for every
/// project.
struct ProjectTagsPage: View {

    // MARK: - Dependencies
    let tags: FieldView
    let open: (String) -> Void

    // MARK: - Body
    var body: some View {
        Form {
            Section {
                if tags.options.isEmpty {
                    Text("project.tags.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                }
                ForEach(tags.options, id: \.key) { option in
                    Button { open(option.key) } label: {
                        HStack {
                            Circle()
                                .fill(Color(hex: option.color) ?? Theme.Colors.secondaryText)
                                .frame(width: 10, height: 10)
                                .accessibilityHidden(true)
                            Text(option.label)
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .listRowButton()
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier(CollectionsIdentifiers.projectTagRowPrefix + option.key)
                }
            } footer: {
                Text("project.tags.footer", bundle: .module)
            }
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProjectTagsPage(tags: ProjectTagPage.previewTags, open: { _ in })
    }
}
