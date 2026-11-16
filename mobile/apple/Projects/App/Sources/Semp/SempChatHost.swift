import CoreKit
import DesignSystem
import SempFeature
import SwiftUI

/// The chat as it is presented over the app: a stack of its own that starts on `presenter.root`, with the grabber
/// at the bottom that closes it again when it is pulled up.
struct SempChatHost: View {

    // MARK: - Dependencies
    @ObservedObject var presenter: SempChatPresenter
    let composition: AppComposition

    // MARK: - Body
    var body: some View {
        NavigationStack(path: $presenter.path) {
            page(presenter.root)
                .navigationDestination(for: SempRoute.self) { page($0) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { SempGrabber(close: presenter.dismiss) }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Subviews
private extension SempChatHost {

    @ViewBuilder
    func page(_ route: SempRoute) -> some View {
        switch route {
        case .thread(let start, let threadId, let inboxItemId, let title, let meta):
            SempScreenFactory.thread(
                makeModel: {
                    composition.models.makeSempThread(
                        start: start,
                        threadId: threadId,
                        inboxItemId: inboxItemId,
                        title: title,
                        meta: meta
                    )
                },
                router: composition.chatRouter
            )
            .id(route)
        case .chats:
            SempScreenFactory.chats(makeModel: { composition.models.makeSempChats() }, router: composition.chatRouter)
        case .approvals:
            SempScreenFactory.approvals(
                makeModel: { composition.models.makeSempApprovals() },
                router: composition.chatRouter
            )
        case .status:
            SempScreenFactory.status(makeModel: { composition.models.makeSempStatus() }, router: composition.chatRouter)
        case .run(let runId, let messageId):
            SempScreenFactory.run(
                makeModel: { composition.models.makeSempRun(runId: runId, messageId: messageId) },
                router: composition.chatRouter
            )
        }
    }
}

/// The handle at the bottom of the chat: pulling it up closes the chat, as does its accessibility action.
private struct SempGrabber: View {

    // MARK: - Dependencies
    let close: () -> Void

    // MARK: - Constants
    private static let pullToClose: CGFloat = 80

    // MARK: - Body
    var body: some View {
        Capsule()
            .fill(.secondary.opacity(0.6))
            .frame(width: 40, height: 5)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 8).onEnded { value in
                    if value.translation.height < -Self.pullToClose { close() }
                }
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("semp.grabber.label"))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { close() }
            .accessibilityIdentifier(AppIdentifiers.sempGrabber)
    }
}
