import Combine
import CoreKit
import Foundation

/// Thin adapter between the internet accounts screen and its shared screen model: republishes the state, forwards
/// intents, maps each effect to the router, and shows the provider's page of a browser sign-in in the browser the
/// sign-in was started with, reporting back how it ended. It owns the model; releasing it closes the shared ViewModel
/// behind the model.
@MainActor
final class InternetAccountsViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InternetAccountsScreenModel
    private let router: any AccountRouting
    /// The browser of the last sign-in that was started; the shared ViewModel asks to open its page.
    private var browser: BrowserSignIn?

    // MARK: - Published Properties
    @Published private(set) var state: InternetAccountsState
    /// Counts the accounts that were connected; the add sheet closes whenever it grows.
    @Published private(set) var connections = 0

    // MARK: - Init
    init(model: any InternetAccountsScreenModel, router: any AccountRouting) {
        self.model = model
        self.router = router
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and routes shared effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] in self?.route($0) }
        )
    }

    func send(_ action: InternetAccountsAction) {
        model.send(action)
    }

    /// Starts the browser sign-in of a new account in `browser`.
    func signIn(_ provider: InternetOAuthProvider, calendars: Bool, browser: BrowserSignIn) {
        self.browser = browser
        model.send(.startSignIn(provider: provider, calendars: calendars))
    }

    /// Reloads in place and returns once the list is no longer refreshing, which is what ends a pull to refresh.
    func refresh() async {
        model.send(.refresh)
        for await state in model.states() where !state.refreshing && state.phase != .loading {
            break
        }
    }
}

// MARK: - Private
private extension InternetAccountsViewModel {

    func route(_ effect: InternetAccountsEffect) {
        switch effect {
        case .openAccount(let accountId): router.showInternetAccount(accountId: accountId)
        case .connected: connections += 1
        case .openSignIn(let url): openSignIn(url)
        }
    }

    func openSignIn(_ url: String) {
        guard let browser else {
            model.send(.signInFailed)
            return
        }
        Task { [weak self] in
            let outcome = await browser.open(url)
            switch outcome {
            case .returned(let callback): self?.model.send(.signInReturned(callbackUrl: callback.absoluteString))
            case .cancelled: self?.model.send(.signInCancelled)
            case .failed: self?.model.send(.signInFailed)
            }
        }
    }
}
