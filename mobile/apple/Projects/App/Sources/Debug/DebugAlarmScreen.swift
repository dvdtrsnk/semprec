import DesignSystem
import SwiftUI

/// The debug tool of system alarms: asks for the permission, schedules an alarm once or every day, or a few seconds
/// from now for a test with the phone locked, and lists and cancels this app's alarms.
struct DebugAlarmScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: DebugAlarmViewModel
    @ObservedObject private var wakeGuard: WakeGuard

    // MARK: - State
    @State private var title = ""
    @State private var repeatsDaily = false
    @State private var time = Date().addingTimeInterval(120)
    @State private var codes: [String] = []
    @State private var scanning = false

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> DebugAlarmViewModel, wakeGuard: WakeGuard) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.wakeGuard = wakeGuard
    }

    // MARK: - Body
    var body: some View {
        Form {
            permission
            if viewModel.authorization != .unsupported {
                newAlarm
                WakeCodesSection(codes: $codes) { scanning = true }
                quickTest
                DebugWakeMissionsSection(wakeGuard: wakeGuard) { id in
                    Task { await viewModel.removeMission(id) }
                }
                scheduled
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $scanning) {
            CodeCaptureSheet { code in
                codes = WakeCodes.normalized(codes + [code])
                scanning = false
            }
        }
        .navigationTitle(Text("debug.alarm.title"))
        .inlineNavigationTitle()
        .alert(
            Text("debug.alarm.failed"),
            isPresented: Binding(get: { viewModel.failure != nil }, set: { _ in viewModel.dismissFailure() })
        ) {
            Button(role: .cancel) {} label: { Text("debug.alarm.ok") }
        } message: {
            Text(viewModel.failure.map(Self.message) ?? "")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AppIdentifiers.debugAlarmScreen)
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension DebugAlarmScreen {

    var permission: some View {
        Section {
            LabeledContent {
                Text(Self.authorizationName(viewModel.authorization))
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmPermission)
            } label: {
                Text("debug.alarm.permission.state")
            }
            if viewModel.authorization == .notDetermined {
                Button { Task { await viewModel.requestAuthorization() } } label: {
                    Text("debug.alarm.permission.request")
                }
                .listRowButton()
                .accessibilityIdentifier(AppIdentifiers.debugAlarmRequestPermission)
            }
        } header: {
            Text("debug.alarm.permission")
        } footer: {
            switch viewModel.authorization {
            case .denied: Text("debug.alarm.permission.denied.footer")
            case .unsupported: Text("debug.alarm.permission.unsupported.footer")
            case .notDetermined, .authorized: Text("debug.alarm.permission.footer")
            }
        }
    }

    var newAlarm: some View {
        Section {
            TextField(text: $title, prompt: Text("debug.alarm.defaultTitle")) { Text("debug.alarm.field.title") }
                .accessibilityIdentifier(AppIdentifiers.debugAlarmTitle)
            Toggle(isOn: $repeatsDaily) { Text("debug.alarm.repeatDaily") }
                .accessibilityIdentifier(AppIdentifiers.debugAlarmRepeat)
            DatePicker(
                selection: $time,
                displayedComponents: repeatsDaily ? [.hourAndMinute] : [.date, .hourAndMinute]
            ) {
                Text("debug.alarm.time")
            }
            .accessibilityIdentifier(AppIdentifiers.debugAlarmTime)
            Button { Task { await viewModel.schedule(title: title, time: alarmTime, codes: codes) } } label: {
                Text("debug.alarm.schedule")
            }
            .listRowButton()
            .disabled(viewModel.isScheduling)
            .accessibilityIdentifier(AppIdentifiers.debugAlarmSchedule)
        } header: {
            Text("debug.alarm.new")
        }
    }

    var quickTest: some View {
        Section {
            quickButton("debug.alarm.in10s", seconds: 10, identifier: AppIdentifiers.debugAlarmIn10s)
            quickButton("debug.alarm.in1m", seconds: 60, identifier: AppIdentifiers.debugAlarmIn1m)
            quickButton("debug.alarm.in5m", seconds: 300, identifier: AppIdentifiers.debugAlarmIn5m)
        } header: {
            Text("debug.alarm.quick")
        } footer: {
            Text("debug.alarm.quick.footer")
        }
    }

    var scheduled: some View {
        Section {
            if viewModel.alarms.isEmpty {
                Text("debug.alarm.empty").foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(viewModel.alarms) { alarm in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.timeText(alarm.time))
                        Text(Self.phaseName(alarm.phase))
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer(minLength: Theme.Spacing.small)
                    Button(role: .destructive) { viewModel.cancel(alarm.id) } label: {
                        Text("debug.alarm.cancel")
                    }
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmCancelPrefix + alarm.id.uuidString)
                }
            }
            if viewModel.alarms.count > 1 {
                Button(role: .destructive) { viewModel.cancelAll() } label: { Text("debug.alarm.cancelAll") }
                    .listRowButton()
                    .accessibilityIdentifier(AppIdentifiers.debugAlarmCancelAll)
            }
        } header: {
            Text("debug.alarm.list")
        }
    }

    func quickButton(_ key: LocalizedStringKey, seconds: TimeInterval, identifier: String) -> some View {
        Button { Task { await viewModel.schedule(title: title, in: seconds, codes: codes) } } label: { Text(key) }
            .listRowButton()
            .disabled(viewModel.isScheduling)
            .accessibilityIdentifier(identifier)
    }

    /// The picked moment, or only its time of day when the alarm repeats.
    var alarmTime: AlarmTime {
        guard repeatsDaily else { return .once(time) }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        return .daily(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }

    static func authorizationName(_ authorization: AlarmAuthorization) -> String {
        switch authorization {
        case .notDetermined: String(localized: "debug.alarm.permission.notDetermined")
        case .denied: String(localized: "debug.alarm.permission.denied")
        case .authorized: String(localized: "debug.alarm.permission.authorized")
        case .unsupported: String(localized: "debug.alarm.permission.unsupported")
        }
    }

    static func timeText(_ time: AlarmTime?) -> String {
        switch time {
        case .once(let date):
            date.formatted(date: .abbreviated, time: .standard)
        case .daily(let hour, let minute):
            String(
                format: String(localized: "debug.alarm.daily"),
                locale: .current,
                String(format: "%02d:%02d", hour, minute)
            )
        case nil:
            String(localized: "debug.alarm.noSchedule")
        }
    }

    static func phaseName(_ phase: AlarmPhase) -> String {
        switch phase {
        case .scheduled: String(localized: "debug.alarm.phase.scheduled")
        case .countdown: String(localized: "debug.alarm.phase.countdown")
        case .paused: String(localized: "debug.alarm.phase.paused")
        case .alerting: String(localized: "debug.alarm.phase.alerting")
        }
    }

    static func message(_ failure: DebugAlarmFailure) -> String {
        switch failure {
        case .notAuthorized: String(localized: "debug.alarm.failure.notAuthorized")
        case .limitReached: String(localized: "debug.alarm.failure.limitReached")
        case .unsupported: String(localized: "debug.alarm.failure.unsupported")
        case .unexpected(let description): description
        }
    }
}
