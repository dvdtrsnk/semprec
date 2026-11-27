import CoreKit
import DesignSystem
import SleepFeature
import SwiftUI

/// The debug tool of system alarms: asks for the permission, rings a test alarm in 10 seconds, a minute or five
/// minutes or at a chosen time once or every day, as a plain alarm or as a wake mission that a stored code stops, and
/// lists and cancels the alarms the app holds. Everything it shows and decides comes from the shared ViewModel; this
/// screen holds only the time being picked. The stored codes are edited in the sleep plan's own wake settings, which
/// this screen opens in a sheet of its own: a sheet opened from a row of a form inside a sheet closes that sheet.
struct DebugAlarmScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: DebugAlarmViewModel
    private let makeWakeSettings: @MainActor () -> any WakeSettingsScreenModel

    // MARK: - State
    @State private var repeatsDaily = false
    @State private var withCodes = false
    @State private var time = Date().addingTimeInterval(120)
    @State private var editingCodes = false

    // MARK: - Init
    /// `makeModel` runs once per screen, when SwiftUI creates the state object.
    init(
        makeModel: @escaping @MainActor () -> any DebugAlarmScreenModel,
        makeWakeSettings: @escaping @MainActor () -> any WakeSettingsScreenModel
    ) {
        _viewModel = StateObject(wrappedValue: DebugAlarmViewModel(model: makeModel()))
        self.makeWakeSettings = makeWakeSettings
    }

    // MARK: - Body
    var body: some View {
        Form {
            permission
            if state.authorization != .unsupported {
                options
                quickTest
                chosenTime
                held
            }
        }
        .formStyle(.grouped)
        // The codes may have changed in the wake settings, so the stored count is read again.
        .sheet(
            isPresented: $editingCodes,
            onDismiss: { viewModel.send(.refresh) },
            content: { SleepScreenFactory.wakeSettings(makeModel: makeWakeSettings) }
        )
        .navigationTitle(Text("debug.alarm.title"))
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { viewModel.send(.refresh) } label: { Text("debug.alarm.refresh") }
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmRefresh)
            }
        }
        .alert(
            Text("debug.alarm.failed"),
            isPresented: Binding(get: { state.failure != nil }, set: { _ in viewModel.send(.dismissFailure) })
        ) {
            Button(role: .cancel) {} label: { Text("debug.alarm.ok") }
        } message: {
            if let failure = state.failure { Text(Self.message(failure)) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.debugAlarmScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension DebugAlarmScreen {

    var state: DebugAlarmState {
        viewModel.state
    }

    var permission: some View {
        Section {
            LabeledContent {
                Text(Self.name(state.authorization))
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmPermission)
            } label: {
                Text("debug.alarm.permission.state")
            }
            if state.authorization == .notDetermined {
                Button { viewModel.send(.requestAuthorization) } label: { Text("debug.alarm.permission.request") }
                    .listRowButton()
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmRequestPermission)
            }
        } header: {
            Text("debug.alarm.permission")
        } footer: {
            Text(Self.footer(state.authorization))
        }
    }

    var options: some View {
        Section {
            Toggle(isOn: $withCodes) { Text("debug.alarm.mission") }
                .accessibilityIdentifier(AppIdentifiers.debugAlarmMission)
            Button { editingCodes = true } label: {
                Label { Text("debug.alarm.codes.edit") } icon: { Image(systemName: "qrcode.viewfinder") }
            }
            .listRowButton()
            .accessibilityIdentifier(AppIdentifiers.debugAlarmEditCodes)
        } header: {
            Text("debug.alarm.options")
        } footer: {
            if state.codeCount == 0 {
                Text("debug.alarm.mission.noCodes")
            } else {
                Text(String(format: String(localized: "debug.alarm.mission.codes"), locale: .current, state.codeCount))
            }
        }
    }

    var quickTest: some View {
        Section {
            quickButton("debug.alarm.in10s", delay: .tenSeconds, identifier: AppIdentifiers.debugAlarmIn10s)
            quickButton("debug.alarm.in1m", delay: .oneMinute, identifier: AppIdentifiers.debugAlarmIn1m)
            quickButton("debug.alarm.in5m", delay: .fiveMinutes, identifier: AppIdentifiers.debugAlarmIn5m)
        } header: {
            Text("debug.alarm.quick")
        } footer: {
            Text("debug.alarm.quick.footer")
        }
    }

    var chosenTime: some View {
        Section {
            Toggle(isOn: $repeatsDaily) { Text("debug.alarm.repeatDaily") }
                .accessibilityIdentifier(AppIdentifiers.debugAlarmRepeat)
            DatePicker(
                selection: $time,
                displayedComponents: repeatsDaily ? [.hourAndMinute] : [.date, .hourAndMinute]
            ) {
                Text("debug.alarm.time")
            }
            .accessibilityIdentifier(AppIdentifiers.debugAlarmTime)
            Button {
                viewModel.send(.ringAt(time, repeat: repeatsDaily ? .daily : .once, withCodes: withCodes))
            } label: {
                Text("debug.alarm.schedule")
            }
            .listRowButton()
            .disabled(state.busy)
            .accessibilityIdentifier(AppIdentifiers.debugAlarmSchedule)
        } header: {
            Text("debug.alarm.new")
        } footer: {
            if repeatsDaily {
                Text(String(
                    format: String(localized: "debug.alarm.repeatDaily.footer"),
                    locale: .current,
                    state.dailyDays
                ))
            }
        }
    }

    var held: some View {
        Section {
            if state.alarms.isEmpty {
                Text("debug.alarm.empty").foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(state.alarms) { alarm in
                HStack {
                    row(alarm)
                    Spacer(minLength: Theme.Spacing.small)
                    Button(role: .destructive) { viewModel.send(.cancel(alarm.id)) } label: {
                        Text("debug.alarm.cancel")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmCancelPrefix + alarm.id)
                }
            }
            if state.alarms.count > 1 {
                Button(role: .destructive) { viewModel.send(.cancelAll) } label: { Text("debug.alarm.cancelAll") }
                    .listRowButton()
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmCancelAll)
            }
        } header: {
            Text("debug.alarm.list")
        } footer: {
            if state.alarms.count > 1 {
                Text("debug.alarm.cancelAll.footer")
            }
        }
    }

    func row(_ alarm: DebugAlarmRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.moment(alarm.ringAt))
            Text(Self.detail(alarm))
                .font(.footnote)
                .foregroundStyle(Theme.Colors.secondaryText)
            if alarm.kind == .mission {
                Text(Self.missionDetail(alarm))
                    .font(.footnote)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    func quickButton(_ key: LocalizedStringKey, delay: DebugAlarmDelay, identifier: String) -> some View {
        Button { viewModel.send(.ringIn(delay, withCodes: withCodes)) } label: { Text(key) }
            .listRowButton()
            .disabled(state.busy)
            .accessibilityIdentifier(identifier)
    }
}

// MARK: - Copy
private extension DebugAlarmScreen {

    static func moment(_ ringAt: Date?) -> String {
        ringAt?.formatted(date: .abbreviated, time: .standard) ?? String(localized: "debug.alarm.noMoment")
    }

    static func name(_ authorization: DebugAlarmAuthorization) -> LocalizedStringKey {
        switch authorization {
        case .notDetermined: "debug.alarm.permission.notDetermined"
        case .denied: "debug.alarm.permission.denied"
        case .authorized: "debug.alarm.permission.authorized"
        case .unsupported: "debug.alarm.permission.unsupported"
        }
    }

    static func footer(_ authorization: DebugAlarmAuthorization) -> LocalizedStringKey {
        switch authorization {
        case .denied: "debug.alarm.permission.denied.footer"
        case .unsupported: "debug.alarm.permission.unsupported.footer"
        case .notDetermined, .authorized: "debug.alarm.permission.footer"
        }
    }

    /// The kind, the owner and the phase of an alarm, which a mission whose own alarm the device lost has none of.
    static func detail(_ alarm: DebugAlarmRow) -> String {
        String(
            format: String(localized: "debug.alarm.row.detail"),
            locale: .current,
            kind(alarm.kind),
            source(alarm.source),
            phase(alarm.phase)
        )
    }

    static func missionDetail(_ alarm: DebugAlarmRow) -> String {
        String(
            format: String(localized: "debug.alarm.row.mission"),
            locale: .current,
            alarm.codeCount,
            alarm.watchCount
        )
    }

    static func kind(_ kind: DebugAlarmKind) -> String {
        switch kind {
        case .alarm: String(localized: "debug.alarm.kind.alarm")
        case .mission: String(localized: "debug.alarm.kind.mission")
        }
    }

    static func source(_ source: DebugAlarmSource) -> String {
        switch source {
        case .sleepPlan: String(localized: "debug.alarm.source.sleepPlan")
        case .debug: String(localized: "debug.alarm.source.debug")
        case .unknown: String(localized: "debug.alarm.source.unknown")
        }
    }

    static func phase(_ phase: DebugAlarmPhase?) -> String {
        switch phase {
        case .scheduled: String(localized: "debug.alarm.phase.scheduled")
        case .alerting: String(localized: "debug.alarm.phase.alerting")
        case nil: String(localized: "debug.alarm.phase.gone")
        }
    }

    static func message(_ failure: DebugAlarmFailure) -> LocalizedStringKey {
        switch failure {
        case .notAuthorized: "debug.alarm.failure.notAuthorized"
        case .limitReached: "debug.alarm.failure.limitReached"
        case .unsupported: "debug.alarm.failure.unsupported"
        case .deviceFailed: "debug.alarm.failure.deviceFailed"
        case .readFailed: "debug.alarm.failure.readFailed"
        case .noCodes: "debug.alarm.failure.noCodes"
        case .inThePast: "debug.alarm.failure.inThePast"
        case .invalidTime: "debug.alarm.failure.invalidTime"
        }
    }
}

// MARK: - Preview
#Preview("Alarms held") {
    NavigationStack {
        DebugAlarmScreen {
            ScriptedDebugAlarmScreenModel(state: DebugAlarmState(
                alarms: [
                    DebugAlarmRow(
                        id: "a1",
                        kind: .mission,
                        ringAt: Date().addingTimeInterval(60),
                        codeCount: 2,
                        watchCount: 48
                    ),
                    DebugAlarmRow(id: "a2", source: .sleepPlan, ringAt: Date().addingTimeInterval(8 * 3600)),
                    DebugAlarmRow(id: "a3", source: .unknown, phase: .alerting)
                ],
                codeCount: 2
            ))
        } makeWakeSettings: {
            previewWakeSettings()
        }
    }
}

#Preview("Permission not asked") {
    NavigationStack {
        DebugAlarmScreen(
            makeModel: { ScriptedDebugAlarmScreenModel(state: DebugAlarmState(authorization: .notDetermined)) },
            makeWakeSettings: previewWakeSettings
        )
    }
}

#Preview("Unsupported") {
    NavigationStack {
        DebugAlarmScreen(
            makeModel: { ScriptedDebugAlarmScreenModel(state: DebugAlarmState(authorization: .unsupported)) },
            makeWakeSettings: previewWakeSettings
        )
    }
}

@MainActor
private func previewWakeSettings() -> any WakeSettingsScreenModel {
    ScriptedWakeSettingsScreenModel(state: WakeSettingsState())
}
