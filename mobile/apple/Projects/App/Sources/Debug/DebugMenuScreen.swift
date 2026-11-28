import DesignSystem
import SwiftUI

/// The debug menu: the tools for trying platform features on a device. It is a page of the profile sheet's stack,
/// which the app owns, and each row asks the app's router to push its tool onto that stack.
struct DebugMenuScreen: View {

    // MARK: - Dependencies
    let openAlarms: () -> Void

    // MARK: - Body
    var body: some View {
        List {
            Section {
                Button(action: openAlarms) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label { Text("debug.row.alarms") } icon: { Image(systemName: "alarm") }
                        Text("debug.row.alarms.detail")
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .accessibilityIdentifier(AppIdentifiers.debugAlarmsRow)
            }
        }
        .navigationTitle(Text("debug.title"))
        .inlineNavigationTitle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.debugMenu)
    }
}

// MARK: - Preview
#Preview {
    NavigationStack { DebugMenuScreen(openAlarms: {}) }
}
