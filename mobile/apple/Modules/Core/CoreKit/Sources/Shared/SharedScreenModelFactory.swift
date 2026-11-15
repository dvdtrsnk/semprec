@preconcurrency internal import SharedSDK

/// Creates the screen models from one Kotlin `HomeSDK`, which owns the data of one app scene.
@MainActor
public final class SharedScreenModelFactory {

    // MARK: - Dependencies
    private let sdk = SharedSDK.HomeSDK(sessionStorage: KeychainSessionStorage(), device: DeviceIdentity.current())

    // MARK: - Init
    public init() {}
}

// MARK: - Protocol conformance
extension SharedScreenModelFactory: ScreenModelFactory {

    public func makeSession() -> any SessionScreenModel {
        SharedSessionScreenModel(sdk.sessionViewModel())
    }

    public func makeLogin() -> any LoginScreenModel {
        SharedLoginScreenModel(sdk.loginViewModel())
    }
}
