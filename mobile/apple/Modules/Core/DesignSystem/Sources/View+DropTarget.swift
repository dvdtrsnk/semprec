import SwiftUI

// MARK: - Registry
/// The objects on the screen that can be dropped onto the Semp bubble, by where they are. One registry belongs to one
/// presentation (the tab bar's content, or one sheet), so only what is on top of that presentation counts: an item
/// under a sheet is in the registry of the presentation below, whose bubble the sheet covers.
@MainActor
public final class DropTargetRegistry {

    // MARK: - Entry
    private struct Entry {
        var frame: CGRect
        let payload: any Sendable
    }

    // MARK: - Properties
    private var entries: [UUID: Entry] = [:]

    // MARK: - Init
    public init() {}

    // MARK: - Methods
    func update(id: UUID, frame: CGRect, payload: any Sendable) {
        entries[id] = Entry(frame: frame, payload: payload)
    }

    func remove(id: UUID) {
        entries[id] = nil
    }

    /// The frame and payload of the smallest registered object under `point` (in global coordinates), or nil.
    public func target(at point: CGPoint) -> (frame: CGRect, payload: any Sendable)? {
        entries.values
            .filter { $0.frame.contains(point) }
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

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { [registry, id, payload] frame in
                registry?.update(id: id, frame: frame, payload: payload)
            }
            .onDisappear { [registry, id] in registry?.remove(id: id) }
    }
}
