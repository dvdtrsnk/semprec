@preconcurrency internal import SharedSDK

// MARK: - Shared values
extension PlaceholderItem {

    init(_ item: SharedSDK.HomeItem) {
        self.init(id: item.id, ordinal: Int(item.ordinal))
    }
}

// MARK: - Shared failures
extension FailureKind {

    init(_ kind: SharedSDK.FailureKind) {
        switch kind {
        case .unavailable: self = .unavailable
        case .invalidData: self = .invalidData
        }
    }
}

// MARK: - Shared settings rows
extension SettingsRow {

    init(_ row: SharedSDK.SettingsRow) {
        switch row {
        case .about: self = .about
        }
    }

    var shared: SharedSDK.SettingsRow {
        switch self {
        case .about: .about
        }
    }
}
