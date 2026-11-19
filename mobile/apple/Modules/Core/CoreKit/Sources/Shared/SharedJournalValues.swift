@preconcurrency internal import SharedSDK

// MARK: - JournalPeriodKind
extension JournalPeriodKind {

    init(_ kind: SharedSDK.JournalPeriodKind) {
        switch kind {
        case .year: self = .year
        case .quarter: self = .quarter
        case .month: self = .month
        case .week: self = .week
        case .day: self = .day
        }
    }

    var shared: SharedSDK.JournalPeriodKind {
        switch self {
        case .year: .year
        case .quarter: .quarter
        case .month: .month
        case .week: .week
        case .day: .day
        }
    }
}

// MARK: - JournalPageRef
extension JournalPageRef {

    init(_ ref: SharedSDK.JournalPageRef) {
        self.init(kind: JournalPeriodKind(ref.kind), period: ref.period)
    }
}

// MARK: - JournalBlockKind
extension JournalBlockKind {

    init(_ kind: SharedSDK.JournalBlockKind) {
        switch kind {
        case .text: self = .text
        case .h1: self = .heading1
        case .h2: self = .heading2
        case .h3: self = .heading3
        case .bullet: self = .bullet
        case .number: self = .number
        case .todo: self = .todo
        case .quote: self = .quote
        case .page: self = .page
        }
    }
}

// MARK: - JournalRun
extension JournalRun {

    init(_ run: SharedSDK.JournalRun) {
        self.init(text: run.text, bold: run.bold, italic: run.italic, code: run.code, link: run.link)
    }
}

// MARK: - JournalBlock
extension JournalBlock {

    init(_ block: SharedSDK.JournalBlock) {
        self.init(
            index: Int(block.index),
            kind: JournalBlockKind(block.kind),
            indent: Int(block.indent),
            done: block.done,
            ordinal: Int(block.ordinal),
            runs: block.runs.map(JournalRun.init),
            pageId: block.pageId
        )
    }
}

// MARK: - JournalPage
extension JournalPage {

    init(_ page: SharedSDK.JournalPageState) {
        self.init(ref: JournalPageRef(page.ref), blocks: page.blocks.map(JournalBlock.init))
    }
}

// MARK: - JournalPhase
extension JournalPhase {

    init(_ phase: SharedSDK.JournalPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

// MARK: - JournalSelection
extension JournalSelection {

    init(_ selection: SharedSDK.JournalSelection) {
        self.init(kind: JournalPeriodKind(selection.kind), start: selection.start)
    }
}

// MARK: - JournalAxisCell
extension JournalAxisCell {

    init(_ cell: SharedSDK.JournalAxisCellState) {
        self.init(
            kind: JournalPeriodKind(cell.kind),
            start: cell.start,
            year: Int(cell.year),
            quarter: Int(cell.quarter),
            month: Int(cell.month),
            day: Int(cell.day),
            weekday: Int(cell.weekday),
            onPath: cell.onPath,
            current: cell.current,
            today: cell.today
        )
    }
}

// MARK: - JournalAxisRow
extension JournalAxisRow {

    init(_ row: SharedSDK.JournalAxisRowState) {
        self.init(kind: JournalPeriodKind(row.kind), cells: row.cells.map(JournalAxisCell.init))
    }
}

// MARK: - JournalWeek
extension JournalWeek {

    init(_ week: SharedSDK.JournalWeekState) {
        self.init(
            number: Int(week.number), firstDay: week.from, lastDay: week.to, page: JournalPage(week.page)
        )
    }
}

// MARK: - JournalEvent
extension JournalEvent {

    init(_ event: SharedSDK.JournalEventState) {
        self.init(
            id: event.id,
            title: event.title,
            startMinutes: event.startMinutes.map { Int(truncating: $0) },
            endMinutes: event.endMinutes.map { Int(truncating: $0) },
            allDay: event.allDay,
            place: event.place,
            projectName: event.projectName,
            projectColor: event.projectColor,
            hasTranscript: event.hasTranscript
        )
    }
}

// MARK: - JournalBirthday
extension JournalBirthday {

    init(_ birthday: SharedSDK.JournalBirthdayState) {
        self.init(id: birthday.id, personName: birthday.personName)
    }
}

// MARK: - JournalInboxStatus
extension JournalInboxStatus {

    init(_ status: SharedSDK.JournalInboxStatus) {
        switch status {
        case .none: self = .none
        case .pending: self = .pending
        case .failed: self = .failed
        case .needsClarification: self = .needsClarification
        case .proposed: self = .proposed
        case .confirmed: self = .confirmed
        case .rejected: self = .rejected
        case .invalid: self = .invalid
        }
    }
}

// MARK: - JournalInboxItem
extension JournalInboxItem {

    init(_ item: SharedSDK.JournalInboxState) {
        self.init(
            id: item.id,
            time: item.time,
            text: item.text,
            emoji: item.emoji,
            status: JournalInboxStatus(item.status),
            attachmentName: item.attachmentName,
            attachmentCount: Int(item.attachmentCount)
        )
    }
}
