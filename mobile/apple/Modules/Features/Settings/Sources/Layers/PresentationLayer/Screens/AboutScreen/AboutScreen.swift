import DesignSystem
import SwiftUI

/// Information about the app, presented as a sheet. It is native only: no shared ViewModel decides anything here.
struct AboutScreen: View {

    // MARK: - Dependencies
    @Environment(\.dismiss)
    private var dismiss
    private let version: String
    private let build: String

    // MARK: - Init
    init(version: String, build: String) {
        self.version = version
        self.build = build
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text("about.title", bundle: .module))
                .inlineNavigationTitle()
                .toolbar { doneButton }
        }
    }
}

// MARK: - Subviews
private extension AboutScreen {

    var content: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text("about.description", bundle: .module)
                .font(Theme.Typography.body)
            Text(String(format: String(localized: "about.version", bundle: .module), locale: .current, version, build))
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SettingsIdentifiers.aboutScreen)
    }

    var doneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button { dismiss() } label: { Text("about.done", bundle: .module) }
                .accessibilityIdentifier(SettingsIdentifiers.aboutDone)
        }
    }
}

// MARK: - Preview
#Preview("About") {
    AboutScreen(version: "0.1.0", build: "1")
}
