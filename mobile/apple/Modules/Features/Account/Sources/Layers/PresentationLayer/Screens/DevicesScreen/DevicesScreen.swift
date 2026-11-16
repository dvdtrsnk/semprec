import CoreKit
import DesignSystem
import SwiftUI

/// The devices the person is signed in on: this one, and the others, each of which can be signed out after a
/// confirmation.
struct DevicesScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: DevicesViewModel

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> DevicesViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("devices.title", bundle: .module))
            .inlineNavigationTitle()
            .confirmationDialog(
                Text(confirmText),
                isPresented: Binding(get: { viewModel.state.confirm != nil }, set: { if !$0 { viewModel.cancel() } }),
                titleVisibility: .visible
            ) {
                Button(role: .destructive) { viewModel.confirm() } label: {
                    Text("devices.signOut", bundle: .module)
                }
                .accessibilityIdentifier(AccountIdentifiers.devicesConfirm)
            }
            .alert(
                Text("devices.failed", bundle: .module),
                isPresented: Binding(get: { viewModel.state.writeFailure != nil }, set: { _ in viewModel.dismissFailure() })
            ) {
                Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AccountIdentifiers.devicesScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension DevicesScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case .content:
            list
        }
    }

    var list: some View {
        List {
            if let current = viewModel.state.current {
                Section {
                    DeviceRow(device: current, isCurrent: true)
                        .accessibilityIdentifier(AccountIdentifiers.devicesCurrent)
                } header: {
                    Text("devices.current", bundle: .module)
                }
            }
            if viewModel.state.others.isEmpty {
                Section {
                    Text("devices.none", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
                }
            } else {
                Section {
                    ForEach(viewModel.state.others) { device in
                        HStack {
                            DeviceRow(device: device, isCurrent: false)
                            Button { viewModel.ask(device) } label: { Text("devices.signOutOne", bundle: .module) }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier(AccountIdentifiers.devicePrefix + device.id)
                        }
                    }
                } header: {
                    Text("devices.others", bundle: .module)
                }
                Section {
                    Button(role: .destructive) { viewModel.askOthers() } label: {
                        Text("devices.signOutOthers", bundle: .module).frame(maxWidth: .infinity)
                    }
                    .accessibilityIdentifier(AccountIdentifiers.devicesSignOutOthers)
                } footer: {
                    Text("devices.hint", bundle: .module)
                }
            }
        }
        .disabled(viewModel.state.working)
    }

    var confirmText: String {
        switch viewModel.state.confirm {
        case .one(let device):
            String(format: String(localized: "devices.confirm.one", bundle: .module), DeviceRow.name(of: device))
        case .others:
            String(localized: "devices.confirm.others", bundle: .module)
        case nil:
            ""
        }
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        DevicesScreen(
            viewModel: DevicesViewModel(
                model: ScriptedDevicesScreenModel(
                    state: DevicesState(
                        phase: .content,
                        current: DeviceItem(
                            id: "s1",
                            kind: .iphone,
                            platform: .ios,
                            name: "iPhone 17 Pro",
                            createdAt: "2026-10-01T10:00:00Z",
                            lastSeenAt: "2026-10-21T10:00:00Z"
                        ),
                        others: [
                            DeviceItem(
                                id: "s2",
                                kind: .mac,
                                platform: .macos,
                                name: "MacBook Pro",
                                createdAt: "2026-09-12T10:00:00Z",
                                lastSeenAt: "2026-10-21T08:00:00Z"
                            )
                        ]
                    )
                )
            )
        )
    }
}
