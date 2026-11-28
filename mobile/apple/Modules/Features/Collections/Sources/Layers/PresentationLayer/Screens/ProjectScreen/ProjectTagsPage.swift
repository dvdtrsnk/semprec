import CoreKit
import DesignSystem
import SwiftUI

/// Every tag of the projects, each opening the page that renames, recolors or deletes it for every project.
struct ProjectTagsPage: View {

    // MARK: - Dependencies
    let tags: FieldView

    // MARK: - Body
    var body: some View {
        Form {
            Section {
                if tags.options.isEmpty {
                    Text("project.tags.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                }
                ForEach(tags.options, id: \.key) { option in
                    NavigationLink(value: ProjectSettingsPage.tag(key: option.key)) {
                        HStack {
                            Circle()
                                .fill(Color(hex: option.color) ?? Theme.Colors.secondaryText)
                                .frame(width: 10, height: 10)
                                .accessibilityHidden(true)
                            Text(option.label)
                        }
                    }
                    .accessibilityIdentifier(CollectionsIdentifiers.projectTagRowPrefix + option.key)
                }
            } footer: {
                Text("project.tags.footer", bundle: .module)
            }
        }
        .navigationTitle(Text(tags.name))
        .inlineNavigationTitle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CollectionsIdentifiers.projectTagsPage)
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProjectTagsPage(tags: ProjectTagPage.previewTags)
    }
}
