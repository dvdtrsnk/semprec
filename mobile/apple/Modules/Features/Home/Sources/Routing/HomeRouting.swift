import Foundation

/// Navigation the Home feature requests. The app implements it on its own navigation stacks.
@MainActor
public protocol HomeRouting: AnyObject {

    // MARK: - Detail
    func showDetail(itemId: String)
}

// MARK: - Preview router
@MainActor
final class PreviewHomeRouter: HomeRouting {

    // MARK: - Methods
    func showDetail(itemId: String) {}
}
