@preconcurrency internal import SharedSDK

// MARK: - NoteEditorBlockType
extension NoteEditorBlockType {

    init(_ type: SharedSDK.NoteEditorBlockType) {
        switch type {
        case .text: self = .text
        case .h1: self = .heading1
        case .h2: self = .heading2
        case .h3: self = .heading3
        case .bullet: self = .bullet
        case .number: self = .number
        case .todo: self = .todo
        case .quote: self = .quote
        case .page: self = .page
        case .toggle: self = .toggle
        }
    }

    var shared: SharedSDK.NoteEditorBlockType {
        switch self {
        case .text: .text
        case .heading1: .h1
        case .heading2: .h2
        case .heading3: .h3
        case .bullet: .bullet
        case .number: .number
        case .todo: .todo
        case .quote: .quote
        case .page: .page
        case .toggle: .toggle
        }
    }
}

// MARK: - NoteEditorMark
extension NoteEditorMark {

    init(_ mark: SharedSDK.NoteEditorMark) {
        switch mark {
        case .bold: self = .bold
        case .italic: self = .italic
        case .code: self = .code
        case .strike: self = .strike
        case .underline: self = .underline
        }
    }

    var shared: SharedSDK.NoteEditorMark {
        switch self {
        case .bold: .bold
        case .italic: .italic
        case .code: .code
        case .strike: .strike
        case .underline: .underline
        }
    }
}

// MARK: - NoteEditorColor
extension NoteEditorColor {

    init(_ color: SharedSDK.NoteEditorColor) {
        switch color {
        case .gray: self = .gray
        case .brown: self = .brown
        case .orange: self = .orange
        case .yellow: self = .yellow
        case .green: self = .green
        case .blue: self = .blue
        case .purple: self = .purple
        case .pink: self = .pink
        case .red: self = .red
        }
    }

    var shared: SharedSDK.NoteEditorColor {
        switch self {
        case .gray: .gray
        case .brown: .brown
        case .orange: .orange
        case .yellow: .yellow
        case .green: .green
        case .blue: .blue
        case .purple: .purple
        case .pink: .pink
        case .red: .red
        }
    }
}

// MARK: - NoteEditorRun
extension NoteEditorRun {

    init(_ run: SharedSDK.NoteEditorRun) {
        self.init(
            run.text,
            bold: run.bold,
            italic: run.italic,
            code: run.code,
            link: run.link,
            strike: run.strike,
            underline: run.underline,
            color: run.color.map(NoteEditorColor.init),
            highlight: run.highlight.map(NoteEditorColor.init)
        )
    }

    var shared: SharedSDK.NoteEditorRun {
        SharedSDK.NoteEditorRun(
            text: text,
            bold: bold,
            italic: italic,
            code: code,
            link: link,
            strike: strike,
            underline: underline,
            color: color?.shared,
            highlight: highlight?.shared
        )
    }
}

// MARK: - NoteEditorBlock
extension NoteEditorBlock {

    init(_ block: SharedSDK.NoteEditorBlock) {
        self.init(
            id: block.id,
            type: NoteEditorBlockType(block.type),
            indent: Int(block.indent),
            done: block.done,
            runs: block.runs.map(NoteEditorRun.init),
            pageId: block.pageId,
            marker: block.marker.map(NoteEditorMarker.init),
            toggle: block.toggle
        )
    }
}

// MARK: - NoteEditorMarker
extension NoteEditorMarker {

    init(_ marker: any SharedSDK.NoteEditorMarker) {
        switch onEnum(of: marker) {
        case .bullet(let bullet): self = .bullet(level: Int(bullet.level))
        case .number(let number): self = .number(number.label)
        }
    }
}

// MARK: - NoteEditorPhase
extension NoteEditorPhase {

    init(_ phase: SharedSDK.NoteEditorPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

// MARK: - NoteEditorProblem
extension NoteEditorProblem {

    /// `nil` when nothing needs telling.
    init?(_ problem: SharedSDK.NoteEditorProblem?, failure: SharedSDK.FailureKind?) {
        switch problem {
        case .none: return nil
        case .some(.reloaded): self = .reloaded
        case .some(.failed): self = .failed(failure.map(FailureKind.init))
        }
    }
}
