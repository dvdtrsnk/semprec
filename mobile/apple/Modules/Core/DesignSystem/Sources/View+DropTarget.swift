import SwiftUI

// MARK: - Registry
/// The objects on the screen that can be dropped onto the Semp bubble, by where they are. On macOS one registry
/// belongs to one presentation (the tab bar's content, or one sheet), so only what is on top of that presentation
/// counts. On iOS one bubble floats over every presentation of the scene, so the scene's registry holds the objects of
/// all of them, and `topLayer` says which presentation is on top at a point: only its objects count there.
@MainActor
public final class DropTargetRegistry {

    // MARK: - Entry
    private struct Entry {
        var frame: CGRect
        let payload: any Sendable
        let layer: PresentationLayer?
    }

    // MARK: - Properties
    private var entries: [UUID: Entry] = [:]
    /// The presentation on top at a point (in global coordinates), compared by identity with the presentation of each
    /// object; nil where presentations do not share one registry, and then every object counts.
    public var topLayer: (@MainActor (CGPoint) -> AnyObject?)?

    // MARK: - Init
    public init() {}

    // MARK: - Methods
    func update(id: UUID, frame: CGRect, payload: any Sendable, layer: PresentationLayer? = nil) {
        entries[id] = Entry(frame: frame, payload: payload, layer: layer)
    }

    func remove(id: UUID) {
        entries[id] = nil
    }

    /// The frame and payload of the smallest registered object under `point` (in global coordinates) on the
    /// presentation on top there, or nil.
    public func target(at point: CGPoint) -> (frame: CGRect, payload: any Sendable)? {
        let top = topLayer.map { $0(point) }
        return entries.values
            .filter { $0.frame.contains(point) }
            .filter { entry in top.map { $0 != nil && entry.layer?.presentation === $0 } ?? true }
            .min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            .map { ($0.frame, $0.payload) }
    }
}

// MARK: - Environment
extension EnvironmentValues {

    /// Where the objects of this presentation that the Semp bubble can pick up register themselves.
    @Entry public var dropTargets: DropTargetRegistry?
}

// MARK: - Modifier
extension View {

    /// Makes this view an object that can be dropped onto the Semp bubble. `payload` is what the bubble receives.
    public func dropTarget(_ payload: some Sendable) -> some View {
        modifier(DropTargetModifier(payload: payload))
    }
}

private struct DropTargetModifier<Payload: Sendable>: ViewModifier {

    // MARK: - Dependencies
    let payload: Payload
    @Environment(\.dropTargets)
    private var registry
    @State private var id = UUID()
    @State private var layer = PresentationLayer()

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .presentationLayer(layer)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { [registry, id, payload, layer] in
                registry?.update(id: id, frame: $0, payload: payload, layer: layer)
            }
            .onDisappear { [registry, id] in registry?.remove(id: id) }
    }
}
