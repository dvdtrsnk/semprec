import CoreKit
import DesignSystem
import SwiftUI

/// The settings rows the shared ViewModel lists. Selecting a row asks the shared ViewModel what to present.
struct SettingsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SettingsViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SettingsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        rows
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SettingsIdentifiers.screen)
            .navigationTitle(Text("settings.title", bundle: .module))
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SettingsScreen {

    var rows: some View {
        List(viewModel.state.rows, id: \.self) { row in
            Button { viewModel.select(row) } label: { label(for: row) }
                .listRowButton()
                .accessibilityIdentifier(identifier(for: row))
        }
    }

    @ViewBuilder
    func label(for row: SettingsRow) -> some View {
        switch row {
        case .about: Label { Text("settings.row.about", bundle: .module) } icon: { Image(systemName: "info.circle") }
        }
    }

    func identifier(for row: SettingsRow) -> String {
        switch row {
        case .about: SettingsIdentifiers.aboutRow
        }
    }
}

// MARK: - Preview
#Preview("Settings") {
    NavigationStack {
        SettingsScreen(viewModel: SettingsViewModel(
            model: ScriptedSettingsScreenModel(state: SettingsState(rows: [.about])),
            router: PreviewSettingsRouter()
        ))
    }
}
