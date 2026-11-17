@preconcurrency internal import SharedSDK

// MARK: - Areas
extension SharedScreenModelFactory {

    public func makeArea(areaId: String) -> any AreaScreenModel {
        SharedAreaScreenModel(sdk.areas.areaViewModel(areaId: areaId, today: { IsoDay.today() }))
    }
}
