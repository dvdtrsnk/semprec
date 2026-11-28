import SwiftUI

/// A toolbar item drawn in the label colour, black in light and white in dark appearance, rather than the accent
/// colour the rest of the app tints with. Confirmation items keep the accent and use `ToolbarItem`.
public struct PlainToolbarItem<Content: View>: ToolbarContent {

    private let placement: ToolbarItemPlacement
    private let content: Content

    public init(placement: ToolbarItemPlacement = .automatic, @ViewBuilder content: () -> Content) {
        self.placement = placement
        self.content = content()
    }

    public var body: some ToolbarContent {
        ToolbarItem(placement: placement) { content.tint(.primary) }
    }
}

/// Several toolbar items drawn in the label colour, as `PlainToolbarItem` draws one.
public struct PlainToolbarItemGroup<Content: View>: ToolbarContent {

    private let placement: ToolbarItemPlacement
    private let content: Content

    public init(placement: ToolbarItemPlacement = .automatic, @ViewBuilder content: () -> Content) {
        self.placement = placement
        self.content = content()
    }

    public var body: some ToolbarContent {
        ToolbarItemGroup(placement: placement) { content.tint(.primary) }
    }
}
