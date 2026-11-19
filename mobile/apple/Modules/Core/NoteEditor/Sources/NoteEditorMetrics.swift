import CoreGraphics

/// Sizes the editor's views share so that a block looks the same edited and not.
enum NoteEditorMetrics {

    /// The inset of the system text editor around its text.
    static let editorInset = CGSize(width: 5, height: 8)

    /// The width of the place in front of a block's text that holds its bullet, number or checkbox.
    static let markerWidth: CGFloat = 24
}
