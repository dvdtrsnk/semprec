import CoreKit
import DesignSystem
import SwiftUI

/// How the sleep plan's alarms wake the person on this device: whether only a scanned code stops them, and the codes,
/// typed or scanned. Each change is kept at once and the alarms follow it. Scanning replaces the form with the camera
/// inside this one sheet, because a sheet opened from a row of a form inside a sheet closes that sheet with it.
struct WakeSettingsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: WakeSettingsViewModel
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var typed = ""
    @State private var scanning = false

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> WakeSettingsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            Group {
                if scanning {
                    WakeCodeCapture { code in
                        viewModel.send(.addCode(code))
                        scanning = false
                    }
                } else {
                    form
                }
            }
            .navigationTitle(Text(scanning ? "sleep.wake.capture.title" : "sleep.wake.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar { toolbar }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SleepIdentifiers.wakeScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension WakeSettingsScreen {

    var state: WakeSettingsState {
        viewModel.state
    }

    var form: some View {
        Form {
            Section {
                Toggle(
                    isOn: SleepBindings.isOn(state.requiresCode) { viewModel.send(.setRequiresCode($0)) }
                ) {
                    Text("sleep.wake.requiresCode", bundle: .module)
                }
                .accessibilityIdentifier(SleepIdentifiers.wakeRequiresCode)
            } footer: {
                footer
            }
            if state.requiresCode {
                codesSection
            }
            if let failure = state.failure {
                failureSection(failure)
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder var footer: some View {
        switch state.mode {
        case .off: Text("sleep.wake.footer.off", bundle: .module)
        case .needsCode: Text("sleep.wake.footer.needsCode", bundle: .module)
        case .active: Text("sleep.wake.footer.on", bundle: .module)
        }
    }

    var codesSection: some View {
        Section {
            ForEach(state.codes, id: \.self) { code in
                HStack {
                    Text(verbatim: code).font(.body.monospaced()).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: Theme.Spacing.small)
                    Button(role: .destructive) { viewModel.send(.removeCode(code)) } label: {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(Text("sleep.wake.code.remove", bundle: .module))
                }
                .accessibilityIdentifier(SleepIdentifiers.wakeCodePrefix + code)
            }
            HStack {
                TextField(
                    text: $typed,
                    prompt: Text("sleep.wake.code.placeholder", bundle: .module)
                ) {
                    Text("sleep.wake.code.type", bundle: .module)
                }
                .font(.body.monospaced())
                .autocorrectionDisabled()
                .onSubmit(addTyped)
                .accessibilityIdentifier(SleepIdentifiers.wakeCodeField)
                Button(action: addTyped) { Image(systemName: "plus.circle.fill") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(Text("sleep.wake.code.add", bundle: .module))
                    .accessibilityIdentifier(SleepIdentifiers.wakeCodeAdd)
            }
            Button { scanning = true } label: {
                Label { Text("sleep.wake.code.scan", bundle: .module) } icon: { Image(systemName: "qrcode.viewfinder") }
            }
            .listRowButton()
            .accessibilityIdentifier(SleepIdentifiers.wakeCodeScan)
        } header: {
            Text("sleep.wake.codes.header", bundle: .module)
        } footer: {
            Text("sleep.wake.codes.footer", bundle: .module)
        }
    }

    func failureSection(_ failure: WakeSettingsFailure) -> some View {
        Section {
            failure.message
                .font(.footnote)
                .foregroundStyle(Theme.Colors.destructive)
            Button { viewModel.send(.dismissFailure) } label: {
                Text("sleep.wake.failure.dismiss", bundle: .module)
            }
            .listRowButton()
        }
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        if scanning {
            ToolbarItem(placement: .cancellationAction) {
                Button { scanning = false } label: { Text("sleep.wake.capture.cancel", bundle: .module) }
            }
        } else {
            ToolbarItem(placement: .confirmationAction) {
                Button { dismiss() } label: { Text("sleep.done", bundle: .module) }
                    .accessibilityIdentifier(SleepIdentifiers.wakeDone)
            }
        }
    }

    func addTyped() {
        viewModel.send(.addCode(typed))
        typed = ""
    }
}

// MARK: - Failure text
private extension WakeSettingsFailure {

    var message: Text {
        switch self {
        case .emptyCode: Text("sleep.wake.failure.emptyCode", bundle: .module)
        case .notAuthorized: Text("sleep.wake.failure.notAuthorized", bundle: .module)
        case .limitReached: Text("sleep.wake.failure.limitReached", bundle: .module)
        case .readFailed: Text("sleep.wake.failure.readFailed", bundle: .module)
        case .deviceFailed: Text("sleep.wake.failure.deviceFailed", bundle: .module)
        }
    }
}

// MARK: - Preview
@MainActor
private func previewScreen(_ state: WakeSettingsState) -> some View {
    WakeSettingsScreen(viewModel: WakeSettingsViewModel(model: ScriptedWakeSettingsScreenModel(state: state)))
}

#Preview("Off") {
    previewScreen(WakeSettingsState())
}

#Preview("Needs a code") {
    previewScreen(WakeSettingsState(requiresCode: true, mode: .needsCode))
}

#Preview("On") {
    previewScreen(
        WakeSettingsState(requiresCode: true, codes: ["4006381333931", "https://example.com/wake"], mode: .active)
    )
}

#Preview("Refused") {
    previewScreen(
        WakeSettingsState(requiresCode: true, codes: ["4006381333931"], mode: .active, failure: .notAuthorized)
    )
}
