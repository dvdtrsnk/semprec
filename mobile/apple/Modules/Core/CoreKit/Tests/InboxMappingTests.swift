import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the Inbox bridge's mappings between Kotlin and Swift values with Kotlin values built here.
/// Both modules declare most of these type names, so each is qualified with its module.
final class InboxMappingTests: XCTestCase {

    // MARK: - State
    @MainActor
    func testInboxMapsLoadingAndFailure() {
        XCTAssertEqual(SharedInboxScreenModel.state(inboxState(.loading)), .loading)
        XCTAssertEqual(
            SharedInboxScreenModel.state(inboxState(.error, failure: .unauthorized)),
            .failure(.unauthorized)
        )
        XCTAssertEqual(SharedInboxScreenModel.state(inboxState(.error)), .failure(nil))
    }

    @MainActor
    func testInboxMapsTheContentOfTheStack() {
        let state = inboxState(
            .content,
            cards: [card(id: "a")],
            result: SharedSDK.InboxResultState(label: "Task", databaseKey: "tasks", itemId: "t1"),
            problem: .decision,
            problemFailure: .rejected,
            picker: SharedSDK.InboxPickerState(
                cardId: "a",
                key: "project",
                multi: true,
                phase: .ready,
                options: [choice(id: nil, none: true)]
            )
        )

        guard case .content(let content) = SharedInboxScreenModel.state(state) else {
            return XCTFail("The state must be content")
        }

        XCTAssertEqual(content.cards.map(\.id), ["a"])
        XCTAssertEqual(content.handled, 3)
        XCTAssertEqual(content.dropped, 1)
        XCTAssertTrue(content.canUndo)
        XCTAssertTrue(content.refreshing)
        XCTAssertTrue(content.busy)
        XCTAssertEqual(content.result, InboxResult(label: "Task", databaseKey: "tasks", itemId: "t1"))
        XCTAssertEqual(content.problem, .decision)
        XCTAssertEqual(content.problemFailure, .rejected)
        XCTAssertEqual(
            content.picker,
            InboxPicker(
                cardId: "a",
                key: "project",
                multi: true,
                phase: .ready,
                options: [SharedInboxScreenModel.choice(choice(id: nil, none: true))]
            )
        )
    }

    @MainActor
    func testACardKeepsItsOriginItsApprovalItsFieldsAndItsChoices() {
        let mapped = SharedInboxScreenModel.card(card(id: "a"))

        XCTAssertEqual(mapped.type, .invalid)
        XCTAssertEqual(mapped.baseType, .task)
        XCTAssertEqual(mapped.phase, .invalid)
        XCTAssertEqual(mapped.approvable, .missingFields)
        XCTAssertEqual(mapped.origin?.kind, .capture)
        XCTAssertEqual(mapped.origin?.text, "Send the invoice")
        XCTAssertEqual(mapped.origin?.typeEmoji, "T")
        XCTAssertEqual(mapped.targets, ["Tasks"])
        XCTAssertEqual(mapped.invalidText, "Archived")
        XCTAssertEqual(mapped.invalidField, "project")
        XCTAssertEqual(mapped.approval, InboxApproval(risk: .outbound, operation: "send", reason: "Asked"))
        XCTAssertEqual(mapped.quotes, ["Hello"])
        XCTAssertEqual(mapped.reason, "Why")
        XCTAssertTrue(mapped.edited)
        XCTAssertTrue(mapped.saving)
        let field = mapped.groups.first?.fields.first
        XCTAssertEqual(mapped.groups.first?.key, "main")
        XCTAssertEqual(field?.key, "date")
        XCTAssertEqual(field?.type, .datetime)
        XCTAssertEqual(field?.keyboard, .email)
        XCTAssertEqual(field?.label, "Date")
        XCTAssertEqual(field?.placeholder, "Pick")
        XCTAssertEqual(field?.required, true)
        XCTAssertEqual(field?.missing, true)
        XCTAssertEqual(field?.edited, true)
        XCTAssertEqual(field?.text, "text")
        XCTAssertEqual(field?.flag, true)
        XCTAssertEqual(field?.date, "2026-10-17")
        XCTAssertEqual(field?.time, "09:00")
        XCTAssertEqual(field?.showTime, true)
        XCTAssertEqual(field?.needsPicker, true)
        XCTAssertEqual(field?.info, "Note")
        XCTAssertEqual(field?.selected.first?.id, "p1")
        XCTAssertEqual(field?.options.map(\.id), ["p1", nil])
    }

    @MainActor
    func testAChoiceKeepsEveryOfItsMembers() {
        let mapped = SharedInboxScreenModel.choice(choice(id: "e1", none: false))

        XCTAssertEqual(
            mapped,
            InboxChoice(
                id: "e1",
                label: "Sprint",
                color: "#007AFF",
                initials: "SP",
                hint: "iOS",
                date: "2026-10-14",
                timeFrom: "13:30",
                timeTo: "14:30",
                selected: true,
                disabled: true,
                suggested: true,
                none: false,
                isNew: true
            )
        )
    }

    @MainActor
    func testAnOriginOfEachKind() {
        let transcript = SharedInboxScreenModel.origin(origin(.transcript))
        XCTAssertEqual(transcript.kind, .transcript)
        XCTAssertEqual(transcript.name, "Call")
        let run = SharedInboxScreenModel.origin(origin(.run))
        XCTAssertEqual(run.kind, .run)
        XCTAssertEqual(run.sourceKind, "tick")
        XCTAssertEqual(run.threadTitle, "Cleanup")
        XCTAssertEqual(run.heartbeatName, "Heartbeat")
        XCTAssertEqual(run.mcpClientName, "Desktop")
    }

    @MainActor
    func testEveryPickerPhaseIsMapped() {
        let phases: [(SharedSDK.InboxPickerPhase, CoreKit.InboxPickerPhase)] = [
            (.loading, .loading), (.ready, .ready), (.error, .error)
        ]
        for (kotlin, swift) in phases {
            let picker = SharedSDK.InboxPickerState(cardId: "a", key: "k", multi: false, phase: kotlin, options: [])
            XCTAssertEqual(SharedInboxScreenModel.picker(picker).phase, swift)
        }
    }

    // MARK: - Enums
    @MainActor
    func testEveryCardTypeAndPhaseAndApprovableIsMapped() {
        XCTAssertEqual(SharedSDK.InboxCardType.allCases.count, 17)
        let types: [(SharedSDK.InboxCardType, CoreKit.InboxCardType)] = [
            (.task, .task), (.event, .event), (.page, .page), (.journal, .journal), (.project, .project),
            (.company, .company), (.person, .person), (.health, .health), (.file, .file),
            (.recording, .recording), (.mcp, .mcp), (.invalid, .invalid), (.clarify, .clarify),
            (.transcriptEvent, .transcriptEvent), (.speaker, .speaker), (.approval, .approval),
            (.unsupported, .unsupported)
        ]
        XCTAssertEqual(types.count, SharedSDK.InboxCardType.allCases.count)
        types.forEach { XCTAssertEqual(SharedInboxScreenModel.type($0.0), $0.1) }
        let phases: [(SharedSDK.InboxCardPhase, CoreKit.InboxCardPhase)] = [
            (.proposed, .proposed), (.computing, .computing), (.computeFailed, .computeFailed),
            (.needsClarification, .needsClarification), (.invalid, .invalid), (.pending, .pending)
        ]
        phases.forEach { XCTAssertEqual(SharedInboxScreenModel.phase($0.0), $0.1) }
        let approvables: [(SharedSDK.InboxApprovable, CoreKit.InboxApprovable)] = [
            (.ready, .ready), (.missingFields, .missingFields), (.computing, .computing),
            (.computeFailed, .computeFailed), (.invalid, .invalid), (.unsupported, .unsupported)
        ]
        approvables.forEach { XCTAssertEqual(SharedInboxScreenModel.approvable($0.0), $0.1) }
    }

    @MainActor
    func testEveryFieldTypeKeyboardRiskAndProblemIsMapped() {
        let fields: [(SharedSDK.InboxFieldType, CoreKit.InboxFieldType)] = [
            (.text, .text), (.area, .area), (.date, .date), (.datetime, .datetime), (.select, .select),
            (.multi, .multi), (.toggle, .toggle), (.seg, .seg), (.color, .color), (.secret, .secret),
            (.info, .info), (.choice, .choice), (.tile, .tile)
        ]
        XCTAssertEqual(fields.count, SharedSDK.InboxFieldType.allCases.count)
        fields.forEach { XCTAssertEqual(SharedInboxScreenModel.fieldType($0.0), $0.1) }
        let keyboards: [(SharedSDK.InboxKeyboard, CoreKit.InboxKeyboard)] = [
            (.text, .text), (.email, .email), (.url, .url), (.tel, .tel)
        ]
        keyboards.forEach { XCTAssertEqual(SharedInboxScreenModel.keyboard($0.0), $0.1) }
        let risks: [(SharedSDK.InboxRiskLevel, CoreKit.InboxRiskLevel)] = [
            (.irreversible, .irreversible), (.outbound, .outbound), (.breaksLink, .breaksLink), (.write, .write)
        ]
        risks.forEach { XCTAssertEqual(SharedInboxScreenModel.risk($0.0), $0.1) }
        let problems: [(SharedSDK.InboxProblem, CoreKit.InboxProblem)] = [
            (.edit, .edit), (.decision, .decision), (.undo, .undo), (.recompute, .recompute)
        ]
        problems.forEach { XCTAssertEqual(SharedInboxScreenModel.problem($0.0), $0.1) }
    }

    // MARK: - Actions and effects
    @MainActor
    func testEveryActionBecomesItsKotlinAction() throws {
        XCTAssertTrue(SharedInboxScreenModel.action(.retry) is SharedSDK.InboxActionRetry)
        XCTAssertTrue(SharedInboxScreenModel.action(.refresh) is SharedSDK.InboxActionRefresh)
        XCTAssertTrue(SharedInboxScreenModel.action(.closePicker) is SharedSDK.InboxActionClosePicker)
        XCTAssertTrue(SharedInboxScreenModel.action(.approve) is SharedSDK.InboxActionApprove)
        XCTAssertTrue(SharedInboxScreenModel.action(.reject) is SharedSDK.InboxActionReject)
        XCTAssertTrue(SharedInboxScreenModel.action(.undo) is SharedSDK.InboxActionUndo)
        XCTAssertTrue(SharedInboxScreenModel.action(.openResult) is SharedSDK.InboxActionOpenResult)
        XCTAssertTrue(SharedInboxScreenModel.action(.dismissResult) is SharedSDK.InboxActionDismissResult)
        XCTAssertTrue(SharedInboxScreenModel.action(.dismissProblem) is SharedSDK.InboxActionDismissProblem)
        let reset = SharedInboxScreenModel.action(.reset(cardId: "a"))
        XCTAssertEqual((reset as? SharedSDK.InboxActionReset)?.cardId, "a")
        let recompute = SharedInboxScreenModel.action(.recompute(cardId: "a"))
        XCTAssertEqual((recompute as? SharedSDK.InboxActionRecompute)?.cardId, "a")
        let open = try XCTUnwrap(SharedInboxScreenModel.action(.openPicker(cardId: "a", key: "project")))
        XCTAssertEqual((open as? SharedSDK.InboxActionOpenPicker)?.key, "project")
        let secret = try XCTUnwrap(SharedInboxScreenModel.action(.setSecret(cardId: "a", text: "sk")))
        XCTAssertEqual((secret as? SharedSDK.InboxActionSetSecret)?.text, "sk")
    }

    @MainActor
    func testEveryFieldActionBecomesItsKotlinAction() throws {
        let text = try XCTUnwrap(
            SharedInboxScreenModel.action(.setText(cardId: "a", key: "name", text: "x"))
                as? SharedSDK.InboxActionSetText
        )
        XCTAssertEqual([text.cardId, text.key, text.text], ["a", "name", "x"])
        let flag = try XCTUnwrap(
            SharedInboxScreenModel.action(.setFlag(cardId: "a", key: "allDay", value: true))
                as? SharedSDK.InboxActionSetFlag
        )
        XCTAssertEqual([flag.cardId, flag.key], ["a", "allDay"])
        XCTAssertTrue(flag.on)
        let date = try XCTUnwrap(
            SharedInboxScreenModel.action(.setDate(cardId: "a", key: "date", date: "2026-10-17"))
                as? SharedSDK.InboxActionSetDate
        )
        XCTAssertEqual(date.date, "2026-10-17")
        let time = try XCTUnwrap(
            SharedInboxScreenModel.action(.setTime(cardId: "a", key: "date", time: "09:00"))
                as? SharedSDK.InboxActionSetTime
        )
        XCTAssertEqual(time.time, "09:00")
        let pick = try XCTUnwrap(
            SharedInboxScreenModel.action(.pick(cardId: "a", key: "project", choiceId: nil))
                as? SharedSDK.InboxActionPick
        )
        XCTAssertNil(pick.choiceId)
        let toggle = try XCTUnwrap(
            SharedInboxScreenModel.action(.toggle(cardId: "a", key: "people", choiceId: "p"))
                as? SharedSDK.InboxActionToggle
        )
        XCTAssertEqual(toggle.choiceId, "p")
    }

    @MainActor
    func testTheOpenItemEffectKeepsTheItemAndItsDatabase() {
        let effect = SharedSDK.InboxEffectOpenItem(databaseKey: "tasks", itemId: "t1")
        XCTAssertEqual(SharedInboxScreenModel.effect(effect), .openItem(databaseKey: "tasks", itemId: "t1"))
        let bare = SharedSDK.InboxEffectOpenItem(databaseKey: nil, itemId: "x")
        XCTAssertEqual(SharedInboxScreenModel.effect(bare), .openItem(databaseKey: nil, itemId: "x"))
    }
}

// MARK: - Kotlin values
private extension InboxMappingTests {

    func inboxState(
        _ phase: SharedSDK.InboxPhase,
        failure: SharedSDK.FailureKind? = nil,
        cards: [SharedSDK.InboxCardState] = [],
        result: SharedSDK.InboxResultState? = nil,
        problem: SharedSDK.InboxProblem? = nil,
        problemFailure: SharedSDK.FailureKind? = nil,
        picker: SharedSDK.InboxPickerState? = nil
    ) -> SharedSDK.InboxState {
        SharedSDK.InboxState(
            phase: phase,
            failure: failure,
            cards: cards,
            handled: 3,
            dropped: 1,
            canUndo: true,
            refreshing: true,
            busy: true,
            result: result,
            problem: problem,
            problemFailure: problemFailure,
            picker: picker
        )
    }

    func choice(id: String?, none: Bool) -> SharedSDK.InboxChoiceItem {
        SharedSDK.InboxChoiceItem(
            id: id,
            label: "Sprint",
            color: "#007AFF",
            initials: "SP",
            hint: "iOS",
            date: "2026-10-14",
            timeFrom: "13:30",
            timeTo: "14:30",
            selected: true,
            disabled: true,
            suggested: true,
            none: none,
            isNew: true
        )
    }

    func origin(_ kind: SharedSDK.InboxOriginKind) -> SharedSDK.InboxOriginState {
        SharedSDK.InboxOriginState(
            kind: kind,
            text: nil,
            date: "2026-10-16",
            time: nil,
            typeLabel: nil,
            typeEmoji: nil,
            name: "Call",
            sourceKind: "tick",
            threadTitle: "Cleanup",
            heartbeatName: "Heartbeat",
            mcpClientName: "Desktop"
        )
    }

    func field() -> SharedSDK.InboxFieldState {
        SharedSDK.InboxFieldState(
            key: "date",
            type: .datetime,
            keyboard: .email,
            label: "Date",
            placeholder: "Pick",
            required: true,
            missing: true,
            edited: true,
            text: "text",
            flag: true,
            date: "2026-10-17",
            time: "09:00",
            showTime: true,
            selected: [choice(id: "p1", none: false)],
            options: [choice(id: "p1", none: false), choice(id: nil, none: true)],
            needsPicker: true,
            info: "Note"
        )
    }

    func card(id: String) -> SharedSDK.InboxCardState {
        SharedSDK.InboxCardState(
            id: id,
            type: .invalid,
            baseType: .task,
            phase: .invalid,
            approvable: .missingFields,
            origin: SharedSDK.InboxOriginState(
                kind: .capture,
                text: "Send the invoice",
                date: "2026-10-16",
                time: "08:12",
                typeLabel: "Task",
                typeEmoji: "T",
                name: nil,
                sourceKind: nil,
                threadTitle: nil,
                heartbeatName: nil,
                mcpClientName: nil
            ),
            targets: ["Tasks"],
            invalidText: "Archived",
            invalidField: "project",
            approval: SharedSDK.InboxApprovalState(risk: .outbound, operation: "send", reason: "Asked"),
            groups: [SharedSDK.InboxGroupState(key: "main", fields: [field()])],
            quotes: ["Hello"],
            reason: "Why",
            edited: true,
            saving: true
        )
    }
}
