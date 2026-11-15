import CoreKit
import Foundation

// MARK: - Names
extension SleepAlarmSound {

    var name: String {
        switch self {
        case .morning: String(localized: "sleep.sound.morning", bundle: .module)
        case .birds: String(localized: "sleep.sound.birds", bundle: .module)
        case .piano: String(localized: "sleep.sound.piano", bundle: .module)
        case .vibrateOnly: String(localized: "sleep.sound.vibrateOnly", bundle: .module)
        }
    }

    /// The line under the name; only the morning sound has one.
    var detail: String? {
        switch self {
        case .morning: String(localized: "sleep.sound.morning.detail", bundle: .module)
        case .birds, .piano, .vibrateOnly: nil
        }
    }

    /// The part of the option's accessibility identifier that names it.
    var identifier: String {
        switch self {
        case .morning: "morning"
        case .birds: "birds"
        case .piano: "piano"
        case .vibrateOnly: "vibrateOnly"
        }
    }
}
