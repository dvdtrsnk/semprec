import Combine
import CoreKit
import Foundation

/// Thin adapter between the internet account screen and its shared screen model: republishes the state, forwards
/// intents, asks the router for the permission to notify when Calendars was switched on, shows the provider's page of
/// a browser sign-in in the browser the sign-in was started with and reports back how it ended, and counts the
/// requests to leave. It owns the model; releasing it closes the shared ViewModel behind the model.
@MainActor
final class InternetAccountViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InternetAccountScreenModel
    private let router: any AccountRouting
    /// The browser of the last sign-in that was started; the shared ViewModel asks to open its page.
    private var browser: BrowserSignIn?

    // MARK: - Published Properties
    @Published private(set) var state: InternetAccountState
    /// Counts the requests to leave the screen; the screen goes back whenever it grows.
    @Published private(set) var closeRequests = 0

    // MARK: - Init
    init(model: any InternetAccountScreenModel, router: any AccountRouting) {
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

    func send(_ action: InternetAccountAction) {
        model.send(action)
    }

    /// Signs the account in again in `browser`.
    func signInAgain(browser: BrowserSignIn) {
        self.browser = browser
        model.send(.signIn(.again))
    }

    /// Asks the provider for calendar access in `browser`.
    func allowCalendarAccess(browser: BrowserSignIn) {
        self.browser = browser
        model.send(.signIn(.allowCalendarAccess))
    }
}

// MARK: - Private
private extension InternetAccountViewModel {

    func route(_ effect: InternetAccountEffect) {
        switch effect {
        case .removed: closeRequests += 1
        case .calendarsTurnedOn: router.requestNotificationPermission()
        case .openSignIn(let url): openSignIn(url)
        }
    }

    func openSignIn(_ url: String) {
        guard let browser else {
            model.send(.signIn(.failed))
            return
        }
        Task { [weak self] in
            let outcome = await browser.open(url)
            switch outcome {
            case .returned(let callback): self?.model.send(.signIn(.returned(callbackUrl: callback.absoluteString)))
            case .cancelled: self?.model.send(.signIn(.cancelled))
            case .failed: self?.model.send(.signIn(.failed))
            }
        }
    }
}
