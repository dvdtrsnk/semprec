@preconcurrency internal import SharedSDK

// MARK: - Mail signals
extension SharedScreenModelFactory {

    public func makeProjectMailSignals(projectId: String) -> any ProjectMailSignalsScreenModel {
        SharedProjectMailSignalsScreenModel(sdk.mailSignals.projectMailSignalsViewModel(projectId: projectId))
    }
}
