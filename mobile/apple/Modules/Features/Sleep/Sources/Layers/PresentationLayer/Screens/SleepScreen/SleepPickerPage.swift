import CoreKit
import DesignSystem
import SwiftUI

/// One of the three pickers of the overview: the reminder lead, the alarm sound or the sleep goal. Picking goes back.
struct SleepPickerPage: View {

    // MARK: - Dependencies
    let state: SleepState
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        Form {
            Section {
                ForEach(options) { option in
                    Button { send(option.action) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title).foregroundStyle(Color.primary)
                                if let subtitle = option.subtitle {
                                    Text(subtitle).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
                                }
                            }
                            Spacer()
                            if option.isSelected { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                        .contentShape(Rectangle())
                    }
                    .listRowButton()
                    .accessibilityAddTraits(option.isSelected ? .isSelected : [])
                    .accessibilityIdentifier(SleepIdentifiers.optionPrefix + option.id)
                }
            } footer: {
                if let hint { Text(hint) }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Options
private extension SleepPickerPage {

    struct Option: Identifiable {

        let id: String
        let title: String
        var subtitle: String?
        let isSelected: Bool
        let action: SleepAction
    }

    var options: [Option] {
        switch state.page {
        case .remind:
            state.reminderLeadOptions.map {
                Option(
                    id: String($0),
                    title: SleepFormat.lead($0),
                    isSelected: $0 == state.prepReminderMinutes,
                    action: .pickMinutes(.reminderLead, minutes: $0)
                )
            }
        case .goal:
            state.goalOptions.map {
                Option(
                    id: String($0),
                    title: SleepFormat.duration($0),
                    isSelected: $0 == state.goalMinutes,
                    action: .pickMinutes(.goal, minutes: $0)
                )
            }
        case .sound:
            SleepAlarmSound.allCases.map {
                Option(
                    id: $0.identifier,
                    title: $0.name,
                    subtitle: $0.detail,
                    isSelected: $0 == state.alarmSound,
                    action: .pickSound($0)
                )
            }
        case .main, .night:
            []
        }
    }

    var hint: String? {
        switch state.page {
        case .remind: String(localized: "sleep.remind.hint", bundle: .module)
        case .goal: String(localized: "sleep.goal.hint", bundle: .module)
        case .main, .night, .sound: nil
        }
    }
}

// MARK: - Preview
#Preview("Goal") {
    SleepPickerPage(state: .previewReady.opening(.goal), send: { _ in })
}
