import SharedSDK
import XCTest

@testable import CoreKit

private typealias Details = SharedItemDetailsScreenModel

/// Checks every branch of the Podrobnosti bridge's mappings between Kotlin and Swift values with Kotlin values
/// built here. Both modules declare most of these type names, so each is qualified with its module.
final class SharedDetailsMappingTests: XCTestCase {

    // MARK: - Podrobnosti state
    @MainActor
    func testDetailsMapsEveryPhase() {
        XCTAssertEqual(Details.state(detailsState(.loading)).phase, .loading)
        XCTAssertEqual(Details.state(detailsState(.content)).phase, .content)
        XCTAssertEqual(
            Details.state(detailsState(.error, failure: .notFound)).phase,
            .failure(.notFound)
        )
        XCTAssertEqual(Details.state(detailsState(.error)).phase, .failure(nil))
    }

    @MainActor
    func testDetailsMapsATaskWithEverythingItHas() {
        let state = Details.state(
            detailsState(
                .content,
                kind: .task,
                title: "Odeslat fakturu",
                description: "Za září",
                flagged: true,
                date: "2026-10-16",
                timeFrom: "14:00",
                timeTo: "15:30",
                lengthMinutes: 90,
                repeat: .weekdays,
                project: SharedSDK.ProjectRef(id: "p1", title: "Účetnictví", color: "#8E8E93"),
                people: [SharedSDK.EntityRef(id: "u1", title: "Karel", color: nil)],
                files: [SharedSDK.EntityRef(id: "f1", title: "Faktura.pdf", color: nil)],
                hostEvents: [SharedSDK.EntityRef(id: "e1", title: "Zubař", color: nil)],
                projectLink: SharedSDK.ValueLink(state: .inherited, sourceTitle: "Schůzka", brokenBySemp: false),
                peopleLink: SharedSDK.ValueLink(state: .broken, sourceTitle: nil, brokenBySemp: true)
            )
        )
        XCTAssertEqual(state.kind, .task)
        XCTAssertEqual(state.title, "Odeslat fakturu")
        XCTAssertEqual(state.description, "Za září")
        XCTAssertTrue(state.flagged)
        XCTAssertEqual([state.date, state.timeFrom, state.timeTo], ["2026-10-16", "14:00", "15:30"])
        XCTAssertEqual(state.lengthMinutes, 90)
        XCTAssertEqual(state.repeats, .weekdays)
        XCTAssertEqual(state.project, CoreKit.ProjectRef(id: "p1", title: "Účetnictví", color: "#8E8E93"))
        XCTAssertEqual(state.people, [CoreKit.EntityRef(id: "u1", title: "Karel")])
        XCTAssertEqual(state.files, [CoreKit.EntityRef(id: "f1", title: "Faktura.pdf")])
        XCTAssertEqual(state.hostEvents, [CoreKit.EntityRef(id: "e1", title: "Zubař")])
        XCTAssertEqual(state.projectLink, CoreKit.ValueLink(state: .inherited, sourceTitle: "Schůzka"))
        XCTAssertEqual(state.peopleLink, CoreKit.ValueLink(state: .broken, brokenBySemp: true))
    }

    @MainActor
    func testDetailsMapsAnEventAndEmptyOptionalValues() {
        let state = Details.state(
            detailsState(
                .content,
                kind: .event,
                place: "Kancelář",
                endDate: "2026-10-18",
                allDay: true,
                company: SharedSDK.EntityRef(id: "c1", title: "Novák Web", color: nil),
                projectLink: SharedSDK.ValueLink(state: .derived, sourceTitle: nil, brokenBySemp: false)
            )
        )
        XCTAssertEqual(state.kind, .event)
        XCTAssertEqual(state.place, "Kancelář")
        XCTAssertEqual(state.endDate, "2026-10-18")
        XCTAssertTrue(state.allDay)
        XCTAssertEqual(state.company, CoreKit.EntityRef(id: "c1", title: "Novák Web"))
        XCTAssertEqual(state.projectLink?.state, .derived)
        XCTAssertNil(state.lengthMinutes)
        XCTAssertNil(state.project)
        XCTAssertNil(state.peopleLink)
        XCTAssertNil(state.notice)
    }

    @MainActor
    func testDetailsMapsEveryRepeatAndLinkState() {
        let repeats: [(SharedSDK.TaskRepeat, CoreKit.TaskRepeat)] = [
            (.none, .never), (.daily, .daily), (.weekdays, .weekdays), (.weekly, .weekly),
            (.monthly, .monthly), (.custom, .custom)
        ]
        for (shared, native) in repeats {
            XCTAssertEqual(Details.state(detailsState(.content, repeat: shared)).repeats, native)
            XCTAssertEqual(native.shared, shared)
        }
        let links: [(SharedSDK.LinkState, CoreKit.LinkState)] = [
            (.inherited, .inherited), (.broken, .broken), (.derived, .derived)
        ]
        for (shared, native) in links {
            XCTAssertEqual(CoreKit.LinkState(shared), native)
        }
        XCTAssertEqual(CoreKit.ItemKind(.task), .task)
        XCTAssertEqual(CoreKit.ItemKind.event.shared, .event)
        XCTAssertEqual(CoreKit.ItemKind.task.shared, .task)
    }

    @MainActor
    func testDetailsMapsTheChoicesAndTheNotice() {
        let phases: [(SharedSDK.ChoicesPhase, CoreKit.ChoicesPhase)] = [
            (.idle, .idle), (.loading, .loading), (.ready, .ready), (.error, .failed)
        ]
        for (shared, native) in phases {
            XCTAssertEqual(Details.state(detailsState(.content, choices: shared)).choices, native)
        }
        let state = Details.state(
            detailsState(
                .content,
                choices: .ready,
                projectChoices: [SharedSDK.ProjectRef(id: "p1", title: "iOS", color: nil)],
                personChoices: [SharedSDK.EntityRef(id: "u1", title: "Karel", color: "#FF9500")],
                notice: .unavailable
            )
        )
        XCTAssertEqual(state.projectChoices, [CoreKit.ProjectRef(id: "p1", title: "iOS")])
        XCTAssertEqual(state.personChoices, [CoreKit.EntityRef(id: "u1", title: "Karel", color: "#FF9500")])
        XCTAssertEqual(state.notice, .unavailable)
    }

    // MARK: - Podrobnosti actions and effects
    @MainActor
    func testDetailsMapsTheActionsWithoutAnArgument() {
        XCTAssertTrue(Details.action(.retry) is SharedSDK.ItemDetailsActionRetry)
        XCTAssertTrue(Details.action(.dismissNotice) is SharedSDK.ItemDetailsActionDismissNotice)
        XCTAssertTrue(Details.action(.loadChoices) is SharedSDK.ItemDetailsActionLoadChoices)
        XCTAssertTrue(Details.action(.toggleDone) is SharedSDK.ItemDetailsActionToggleDone)
        XCTAssertTrue(Details.action(.delete) is SharedSDK.ItemDetailsActionDelete)
    }

    @MainActor
    func testDetailsMapsTheTextAndSwitchActions() throws {
        let title = try XCTUnwrap(Details.action(.setTitle("A")) as? SharedSDK.ItemDetailsActionSetTitle)
        XCTAssertEqual(title.title, "A")
        let description = try XCTUnwrap(
            Details.action(.setDescription("D")) as? SharedSDK.ItemDetailsActionSetDescription
        )
        XCTAssertEqual(description.text, "D")
        let place = try XCTUnwrap(Details.action(.setPlace("P")) as? SharedSDK.ItemDetailsActionSetPlace)
        XCTAssertEqual(place.text, "P")
        let flagged = try XCTUnwrap(
            Details.action(.setFlagged(true)) as? SharedSDK.ItemDetailsActionSetFlagged
        )
        XCTAssertTrue(flagged.flagged)
        let timed = try XCTUnwrap(Details.action(.setTimed(true)) as? SharedSDK.ItemDetailsActionSetTimed)
        XCTAssertTrue(timed.timed)
        let ended = try XCTUnwrap(Details.action(.setEnded(false)) as? SharedSDK.ItemDetailsActionSetEnded)
        XCTAssertFalse(ended.ended)
        let allDay = try XCTUnwrap(Details.action(.setAllDay(true)) as? SharedSDK.ItemDetailsActionSetAllDay)
        XCTAssertTrue(allDay.allDay)
        let repeats = try XCTUnwrap(
            Details.action(.setRepeat(.monthly)) as? SharedSDK.ItemDetailsActionSetRepeat
        )
        XCTAssertEqual(repeats.repeat, .monthly)
    }

    @MainActor
    func testDetailsMapsTheScheduleAndRelationActions() throws {
        let date = try XCTUnwrap(Details.action(.setDate("2026-10-16")) as? SharedSDK.ItemDetailsActionSetDate)
        XCTAssertEqual(date.date, "2026-10-16")
        let noDate = try XCTUnwrap(Details.action(.setDate(nil)) as? SharedSDK.ItemDetailsActionSetDate)
        XCTAssertNil(noDate.date)
        let from = try XCTUnwrap(Details.action(.setTimeFrom("09:00")) as? SharedSDK.ItemDetailsActionSetTimeFrom)
        XCTAssertEqual(from.time, "09:00")
        let end = try XCTUnwrap(Details.action(.setTimeTo("10:00")) as? SharedSDK.ItemDetailsActionSetTimeTo)
        XCTAssertEqual(end.time, "10:00")
        let project = try XCTUnwrap(
            Details.action(.selectProject("p1")) as? SharedSDK.ItemDetailsActionSelectProject
        )
        XCTAssertEqual(project.projectId, "p1")
        let noProject = try XCTUnwrap(
            Details.action(.selectProject(nil)) as? SharedSDK.ItemDetailsActionSelectProject
        )
        XCTAssertNil(noProject.projectId)
        let person = try XCTUnwrap(
            Details.action(.togglePerson("u1")) as? SharedSDK.ItemDetailsActionTogglePerson
        )
        XCTAssertEqual(person.personId, "u1")
        let file = try XCTUnwrap(Details.action(.removeFile("f1")) as? SharedSDK.ItemDetailsActionRemoveFile)
        XCTAssertEqual(file.fileId, "f1")
        let unlink = try XCTUnwrap(Details.action(.unlink(.project)) as? SharedSDK.ItemDetailsActionUnlink)
        XCTAssertEqual(unlink.value, .project)
        let relink = try XCTUnwrap(Details.action(.relink(.people)) as? SharedSDK.ItemDetailsActionRelink)
        XCTAssertEqual(relink.value, .people)
    }

    @MainActor
    func testDetailsMapsTheDeletedEffect() {
        XCTAssertEqual(Details.effect(SharedSDK.ItemDetailsEffectDeleted.shared), .deleted)
    }
}

// MARK: - Builders
private extension SharedDetailsMappingTests {

    func detailsState(
        _ phase: SharedSDK.ItemDetailsPhase,
        failure: SharedSDK.FailureKind? = nil,
        kind: SharedSDK.ItemKind = .task,
        title: String = "",
        description: String = "",
        place: String = "",
        flagged: Bool = false,
        date: String? = nil,
        endDate: String? = nil,
        timeFrom: String? = nil,
        timeTo: String? = nil,
        allDay: Bool = false,
        lengthMinutes: Int32? = nil,
        repeat repeats: SharedSDK.TaskRepeat = .none,
        project: SharedSDK.ProjectRef? = nil,
        people: [SharedSDK.EntityRef] = [],
        files: [SharedSDK.EntityRef] = [],
        hostEvents: [SharedSDK.EntityRef] = [],
        company: SharedSDK.EntityRef? = nil,
        projectLink: SharedSDK.ValueLink? = nil,
        peopleLink: SharedSDK.ValueLink? = nil,
        choices: SharedSDK.ChoicesPhase = .idle,
        projectChoices: [SharedSDK.ProjectRef] = [],
        personChoices: [SharedSDK.EntityRef] = [],
        notice: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.ItemDetailsState {
        SharedSDK.ItemDetailsState(
            phase: phase,
            failure: failure,
            kind: kind,
            title: title,
            done: false,
            description: description,
            place: place,
            flagged: flagged,
            date: date,
            endDate: endDate,
            timeFrom: timeFrom,
            timeTo: timeTo,
            allDay: allDay,
            lengthMinutes: lengthMinutes.map { KotlinInt(int: $0) },
            repeat: repeats,
            project: project,
            people: people,
            files: files,
            hostEvents: hostEvents,
            company: company,
            projectLink: projectLink,
            peopleLink: peopleLink,
            choices: choices,
            projectChoices: projectChoices,
            personChoices: personChoices,
            notice: notice
        )
    }
}
