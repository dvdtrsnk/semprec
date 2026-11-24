import DesignSystem
import SwiftUI

/// The codes a new alarm asks for before it stops: scanned with the camera or typed. With at least one, the alarm is a
/// wake-up mission that rings until one of them is scanned.
struct DebugWakeCodesSection: View {

    // MARK: - Dependencies
    @Binding var codes: [String]

    // MARK: - State
    @State private var typed = ""
    @State private var scanning = false

    // MARK: - Body
    var body: some View {
        Section {
            ForEach(codes, id: \.self) { code in
                HStack {
                    Text(verbatim: code).font(.body.monospaced()).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: Theme.Spacing.small)
                    Button(role: .destructive) { codes.removeAll { $0 == code } } label: {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(Text("debug.wake.code.remove"))
                }
            }
            HStack {
                TextField(text: $typed, prompt: Text("debug.wake.code.placeholder")) { Text("debug.wake.code.type") }
                    .font(.body.monospaced())
                    .onSubmit(addTyped)
                    .accessibilityIdentifier(AppIdentifiers.debugWakeCodeField)
                Button(action: addTyped) { Image(systemName: "plus.circle.fill") }
                    .buttonStyle(.borderless)
                    .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel(Text("debug.wake.code.add"))
            }
            Button { scanning = true } label: {
                Label { Text("debug.wake.code.scan") } icon: { Image(systemName: "qrcode.viewfinder") }
            }
            .listRowButton()
            .accessibilityIdentifier(AppIdentifiers.debugWakeCodeScan)
        } header: {
            Text("debug.wake.codes")
        } footer: {
            Text("debug.wake.codes.footer")
        }
        .sheet(isPresented: $scanning) {
            DebugCodeCaptureSheet { code in
                add(code)
                scanning = false
            }
        }
    }
}

// MARK: - Private
private extension DebugWakeCodesSection {

    func addTyped() {
        add(typed)
        typed = ""
    }

    func add(_ code: String) {
        codes = WakeGuard.normalized(codes + [code])
    }
}
