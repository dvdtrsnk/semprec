import CoreKit
import DesignSystem
import SwiftUI

/// The file an item holds: its name and size, and a button that downloads it for a preview.
struct FileValueView: View {

    // MARK: - Dependencies
    let field: FieldView
    let format: FieldFormat
    let send: (ItemAction) -> Void

    // MARK: - Body
    var body: some View {
        if case .blob(_, let filename, let mimeType, let byteSize) = field.content {
            Button { send(.preview(.load(propertyKey: field.propertyKey))) } label: {
                VStack(alignment: .trailing, spacing: 2) {
                    Label {
                        Text(filename ?? mimeType).lineLimit(1)
                    } icon: {
                        Image(systemName: "doc.text.magnifyingglass")
                    }
                    Text(format.fileSize(byteSize)).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.Colors.accent)
        } else {
            Text("field.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}
