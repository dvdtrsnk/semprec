import CoreKit
import DesignSystem
import SwiftUI

/// The stack of cards with the buttons that decide the top one. A drag of the top card to the right approves it (when
/// it may be approved), to the left discards it; vertical drags scroll the fields of the card.
struct InboxDeckView: View {

    // MARK: - Dependencies
    let content: InboxContent
    let send: (InboxAction) -> Void

    // MARK: - Properties
    @State private var dragOffset: CGFloat = 0
    @FocusState private var focus: String?

    // MARK: - Body
    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            ZStack {
                cardBacks
                if let top = content.cards.first {
                    InboxCardView(
                        card: top,
                        openingAttachment: content.attachment?.openingId,
                        focus: $focus,
                        send: send
                    )
                        .id(top.id)
                        .offset(x: dragOffset)
                        .rotationEffect(.degrees(Double(dragOffset) / Self.rotationDivisor))
                        .simultaneousGesture(swipe(top))
                }
            }
            .frame(maxWidth: Self.maxCardWidth, maxHeight: .infinity)
            InboxDecisionBar(card: content.cards.first, busy: content.busy, dragOffset: dragOffset, send: decide)
                .frame(maxWidth: Self.maxCardWidth)
        }
        .padding([.horizontal, .bottom], Theme.Spacing.medium)
        .overlay(alignment: .top) { notices }
        .sheet(isPresented: pickerShown) {
            if let picker = content.picker { InboxPickerSheet(picker: picker, card: content.cards.first, send: send) }
        }
        .inboxAttachmentPreview(content.attachment) { send(.closeAttachment) }
    }

    // MARK: - Constants
    private static let rotationDivisor: Double = 22
    private static let swipeDistance: CGFloat = 110
    private static let maxCardWidth: CGFloat = 560
}

// MARK: - Subviews
private extension InboxDeckView {

    var cardBacks: some View {
        ZStack {
            if content.cards.count > 2 { back(offset: CGSize(width: 9, height: 12), angle: 4.5) }
            if content.cards.count > 1 { back(offset: CGSize(width: -7, height: 7), angle: -3) }
        }
        .accessibilityHidden(true)
    }

    func back(offset: CGSize, angle: Double) -> some View {
        RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
            .fill(Theme.Colors.card)
            .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
            .offset(offset)
            .rotationEffect(.degrees(angle))
    }

    var notices: some View {
        VStack(spacing: Theme.Spacing.small) {
            if let result = content.result {
                InboxToastView(result: result, send: send)
            }
            if let problem = content.problem {
                InboxProblemView(problem: problem, failure: content.problemFailure, send: send)
            }
        }
        .padding(.top, Theme.Spacing.small)
    }

    var pickerShown: Binding<Bool> {
        Binding(
            get: { content.picker != nil },
            set: { shown in if !shown { send(.closePicker) } }
        )
    }

    /// A decision first takes what is typed in a field, which leaving the field sends, and then goes out itself.
    func decide(_ action: InboxAction) {
        focus = nil
        Task { @MainActor in
            await Task.yield()
            send(action)
        }
    }

    func swipe(_ card: InboxCard) -> some Gesture {
        let ready = card.approvable == .ready && !content.busy
        return DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = ready ? value.translation.width : min(value.translation.width, 0)
            }
            .onEnded { _ in
                let distance = dragOffset
                withAnimation(.snappy) { dragOffset = 0 }
                guard !content.busy else { return }
                if distance > Self.swipeDistance { decide(.approve) }
                if distance < -Self.swipeDistance { decide(.reject) }
            }
    }
}
