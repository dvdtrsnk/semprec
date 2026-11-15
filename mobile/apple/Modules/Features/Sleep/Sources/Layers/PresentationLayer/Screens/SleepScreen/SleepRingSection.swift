import CoreKit
import DesignSystem
import SwiftUI

/// The ring of the sheet with the two times under it: bedtime and wake-up (or alarm).
struct SleepRingSection: View {

    // MARK: - Dependencies
    let ring: SleepRing
    let isEnabled: Bool
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        Section {
            VStack(spacing: Theme.Spacing.medium) {
                SleepRingView(ring: ring, isEnabled: isEnabled)
                HStack(spacing: Theme.Spacing.small) {
                    SleepTimeButton(
                        title: Text("sleep.ring.bed", bundle: .module),
                        minutes: ring.bedMinutes,
                        accessibilityLabel: format("sleep.ring.bed.a11y", SleepFormat.time(ring.bedMinutes)),
                        identifier: SleepIdentifiers.bed
                    ) { send(.setTime(.bed, minutes: $0)) }
                    SleepTimeButton(
                        title: wakeTitle,
                        minutes: ring.wakeMinutes,
                        accessibilityLabel: wakeLabel,
                        identifier: SleepIdentifiers.wake
                    ) { send(.setTime(.wake, minutes: $0)) }
                }
            }
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
        }
    }
}

// MARK: - Subviews
private extension SleepRingSection {

    var wakeTitle: Text {
        ring.alarm ? Text("sleep.ring.alarm", bundle: .module) : Text("sleep.ring.wake", bundle: .module)
    }

    var wakeLabel: String {
        let time = SleepFormat.time(ring.wakeMinutes)
        return ring.alarm ? format("sleep.ring.alarm.a11y", time) : format("sleep.ring.wake.a11y", time)
    }

    func format(_ key: String.LocalizationValue, _ argument: String) -> String {
        String(format: String(localized: key, bundle: .module), locale: .current, argument)
    }
}
