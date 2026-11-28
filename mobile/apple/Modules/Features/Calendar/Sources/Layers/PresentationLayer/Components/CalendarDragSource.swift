#if os(iOS)
import CoreKit
import SwiftUI

/// What the day view tells the drag source: the item at a place of the day, where an item is drawn, and what happens
/// as one lifts and as its drag ends. Places are in the day view's coordinates.
struct CalendarDragSourceModel {

    /// The event or task that lifts under a finger at a place, if any may.
    let item: (CGPoint) -> CalendarItem?
    let frame: (String) -> CGRect?
    let transfer: (CalendarItem) -> CalendarItemTransfer
    /// Whether a place is over the day, where the item's own block follows the finger and the drag shows no card.
    let isOverDay: (CGPoint) -> Bool
    let lifted: (CalendarItem, CGPoint) -> Void
    let ended: () -> Void
}

/// The source of the system's drag of the day's items on iOS, as the system Calendar's: a held event or task lifts
/// out of the day, and while its finger is over the day only its own block moves with it; the card of the drag shows
/// once the finger leaves the day, for the rest of the screen and for other apps, and goes when it comes back. SwiftUI
/// draws the card of its own drags for the whole drag, so the drag is the system's own, set up on the view that holds
/// the day view, and the card changes with the system's preview provider of the drag item. It sits behind the day view,
/// takes no touches itself and fills it, so its places are the day view's.
struct CalendarDragSource: UIViewRepresentable {

    // MARK: - Dependencies
    let model: CalendarDragSourceModel

    // MARK: - UIViewRepresentable
    func makeCoordinator() -> CalendarDragCoordinator { CalendarDragCoordinator(model: model) }

    func makeUIView(context: Context) -> CalendarHostAttachment {
        let coordinator = context.coordinator
        let attachment = CalendarHostAttachment { host in
            host.addInteraction(coordinator.interaction)
            return { host.removeInteraction(coordinator.interaction) }
        }
        coordinator.anchor = attachment
        return attachment
    }

    func updateUIView(_ attachment: CalendarHostAttachment, context: Context) {
        context.coordinator.model = model
    }
}

/// Answers the system's drag: what lifts and how, and which preview the drag shows where.
final class CalendarDragCoordinator: NSObject, UIDragInteractionDelegate {

    // MARK: - Properties
    var model: CalendarDragSourceModel
    /// The view the drag's places are read in, which fills the day view.
    weak var anchor: UIView?
    private(set) lazy var interaction: UIDragInteraction = {
        let interaction = UIDragInteraction(delegate: self)
        interaction.isEnabled = true
        return interaction
    }()
    /// The item being dragged, its drag item and the card it shows away from the day.
    private var dragged: (item: CalendarItem, dragItem: UIDragItem, card: UIView)?
    private var showsCard = false

    // MARK: - Init
    init(model: CalendarDragSourceModel) {
        self.model = model
        super.init()
        // The app goes to the background under a held drag, to another app: the drag shows its card there.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
    }

    @objc
    private func appWillResignActive() {
        showCard(true)
    }

    // MARK: - UIDragInteractionDelegate
    func dragInteraction(_ interaction: UIDragInteraction, itemsForBeginning session: UIDragSession) -> [UIDragItem] {
        guard let anchor, dragged == nil else { return [] }
        let location = session.location(in: anchor)
        guard let item = model.item(location) else { return [] }
        let provider = NSItemProvider()
        let transfer = model.transfer(item)
        provider.register(transfer)
        let dragItem = UIDragItem(itemProvider: provider)
        dragItem.localObject = item.id
        let card = Self.card(for: item, scale: anchor.traitCollection.displayScale)
        dragged = (item, dragItem, card)
        showsCard = false
        dragItem.previewProvider = { Self.hiddenPreview() }
        model.lifted(item, location)
        return [dragItem]
    }

    /// The item's own block lifts out of the day.
    func dragInteraction(
        _ interaction: UIDragInteraction,
        previewForLifting item: UIDragItem,
        session: UIDragSession
    ) -> UITargetedPreview? {
        guard let anchor, let id = item.localObject as? String, let frame = model.frame(id),
            let snapshot = anchor.window?.resizableSnapshotView(
                from: anchor.convert(frame, to: anchor.window),
                afterScreenUpdates: false,
                withCapInsets: .zero
            ) else { return nil }
        let parameters = UIPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: snapshot.bounds, cornerRadius: 6)
        let target = UIPreviewTarget(container: anchor, center: CGPoint(x: frame.midX, y: frame.midY))
        return UITargetedPreview(view: snapshot, parameters: parameters, target: target)
    }

    func dragInteraction(_ interaction: UIDragInteraction, sessionDidMove session: UIDragSession) {
        guard let anchor else { return }
        showCard(!model.isOverDay(session.location(in: anchor)))
    }

    func dragInteraction(_ interaction: UIDragInteraction, sessionAllowsMoveOperation session: UIDragSession) -> Bool {
        true
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        session: UIDragSession,
        didEndWith operation: UIDropOperation
    ) {
        dragged = nil
        model.ended()
    }

    /// A drag that is let go of where nothing takes it ends without the card flying back to the day.
    func dragInteraction(
        _ interaction: UIDragInteraction,
        previewForCancelling item: UIDragItem,
        withDefault defaultPreview: UITargetedPreview
    ) -> UITargetedPreview? {
        nil
    }

    // MARK: - Private
    private func showCard(_ shows: Bool) {
        guard let dragged, shows != showsCard else { return }
        showsCard = shows
        let card = dragged.card
        dragged.dragItem.previewProvider = shows ? { UIDragPreview(view: card) } : { Self.hiddenPreview() }
    }

    /// The card of the drag: the item's colour, title and time, drawn once as a picture, which the system's preview
    /// shows as it is, at the scale of the screen the day is on.
    private static func card(for item: CalendarItem, scale: CGFloat) -> UIView {
        let renderer = ImageRenderer(content: CalendarDragPreview(item: item).fixedSize())
        renderer.scale = scale
        let image = renderer.uiImage ?? UIImage()
        let view = UIImageView(image: image)
        view.frame = CGRect(origin: .zero, size: image.size)
        return view
    }

    /// No picture at all: over the day the item's own block is what moves with the finger.
    private static func hiddenPreview() -> UIDragPreview {
        let view = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        let parameters = UIDragPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.shadowPath = UIBezierPath()
        parameters.visiblePath = UIBezierPath(rect: CGRect(x: 0, y: 0, width: 1, height: 1))
        return UIDragPreview(view: view, parameters: parameters)
    }
}
#endif
