package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun text(value: String) = InboxValue.Text(value)

private fun flag(on: Boolean) = InboxValue.Flag(on)

private fun whenIs(field: String, value: InboxValue) = InboxCondition(field, value, negated = false)

private val taskSchema = InboxSchema(
    "task",
    listOf(
        InboxGroup(
            "main",
            listOf(
                InboxField("name", InboxControl.TEXT, required = true),
                InboxField("date", InboxControl.DATETIME, timeHiddenWhen = whenIs("allDay", flag(true))),
                InboxField("allDay", InboxControl.TOGGLE),
                InboxField("status", InboxControl.SELECT),
            ),
        ),
        InboxGroup(
            "links",
            listOf(
                InboxField("project", InboxControl.SELECT, optionsSource = "project"),
                InboxField("company", InboxControl.SELECT, optionsSource = "company"),
            ),
        ),
        InboxGroup(
            "followup",
            listOf(
                InboxField("followupTask", InboxControl.TOGGLE),
                InboxField(
                    "followDate",
                    InboxControl.DATE,
                    required = true,
                    whenHolds = whenIs("followupTask", flag(true)),
                ),
            ),
        ),
    ),
)

private fun envelope(
    properties: Map<String, InboxValue> = mapOf("name" to text("Send the invoice"), "date" to text("2026-10-17")),
    relations: Map<String, List<String>> = emptyMap(),
    steps: List<InboxStep> = emptyList(),
    kind: InboxEntityKind = InboxEntityKind.DATABASE,
    target: String = "db-tasks",
) = InboxEnvelope(kind, target, properties, relations, steps)

private fun step(ref: String, primary: Boolean, enabled: Boolean = true) = InboxStep(
    ref = ref,
    operation = "create",
    primary = primary,
    databaseKey = "tasks",
    enabled = enabled,
    optional = !primary,
    properties = if (primary) mapOf("name" to text("Pay")) else mapOf("date" to text("2026-10-30")),
    relations = emptyMap(),
)

private fun card(
    kind: InboxCardKind = InboxCardKind.TASK,
    status: InboxCardStatus = InboxCardStatus.PROPOSED,
    envelope: InboxEnvelope? = envelope(),
    schema: InboxSchema? = taskSchema,
    properties: Map<String, InboxPropertyInfo> = emptyMap(),
    context: InboxContext = InboxContext.None,
    userValues: Map<String, InboxValue> = emptyMap(),
) = InboxCard(
    id = "c1",
    kind = kind,
    baseKind = kind,
    status = status,
    version = "v1",
    origin = null,
    targets = emptyList(),
    envelope = envelope,
    schema = schema,
    properties = properties,
    context = context,
    userValues = userValues,
)

private fun relation(key: String) = mapOf(key to InboxPropertyInfo(key, InboxPropertyType.RELATION, emptyList()))

private fun pick(id: String?) = InboxInput.Pick(InboxChoice(id, "label", none = id == null))

private fun InboxCard.fieldOf(key: String) = editorGroups().flatMap { it.fields }.first { it.key == key }

/** The edit a change writes; the change must be one. */
private fun InboxCard.edit(key: String, input: InboxInput): InboxEdit =
    assertIs<InboxChange.Edit>(change(fieldOf(key), input)).edit

private fun InboxCard.primary(key: String, input: InboxInput) = edit(key, input).values.getValue("primary")

private val followSteps = listOf(step("main", primary = true), step("follow", primary = false))

class InboxRulesTest {
    @Test fun `a value is the proposals own then the persons own then what the proposal implies`() {
        val withUser = card(userValues = mapOf("primary.allDay" to flag(true), "primary.name" to text("x")))
        assertEquals(text("Send the invoice"), withUser.valueOf("name"))
        assertEquals(flag(true), withUser.valueOf("allDay"))
        assertNull(card().valueOf("allDay"))
        val page = card(envelope = envelope(kind = InboxEntityKind.PAGE_CONTENT, target = "page-1"))
        assertEquals(text("page-1"), page.valueOf("page"))
        assertNull(card().valueOf("page"))
    }

    @Test fun `a journal entry keeps its day under the date key`() {
        val journal = card(
            kind = InboxCardKind.JOURNAL,
            envelope = envelope(mapOf("date" to text("2026-10-16")), kind = InboxEntityKind.JOURNAL_ENTRY),
        )
        assertEquals(text("2026-10-16"), journal.valueOf("day"))
        val change = journal.change(InboxField("day", InboxControl.DATE), InboxInput.Date("2026-10-17"))
        assertEquals(
            mapOf("date" to text("2026-10-17")),
            assertIs<InboxChange.Edit>(change).edit.values["primary"],
        )
    }

    @Test fun `the follow up fields exist only when the proposal has a follow up step`() {
        val without = card()
        assertFalse(without.isVisible(without.fieldOf("followupTask")))
        val switchedOff = step("follow", primary = false, enabled = false)
        val off = card(envelope = envelope(steps = listOf(followSteps[0], switchedOff)))
        assertTrue(off.isVisible(off.fieldOf("followupTask")))
        assertFalse(off.isVisible(off.fieldOf("followDate")))
        assertEquals(flag(false), off.valueOf("followupTask"))
        val on = card(envelope = envelope(steps = followSteps))
        assertTrue(on.isVisible(on.fieldOf("followDate")))
        assertEquals(text("2026-10-30"), on.valueOf("followDate"))
    }

    @Test fun `a condition holds when the field has the value and a not equal one when it has not`() {
        val equals = whenIs("status", text("done"))
        val differs = equals.copy(negated = true)
        val done = card(envelope = envelope(mapOf("status" to text("done"))))
        assertTrue(done.holds(equals))
        assertFalse(done.holds(differs))
        assertFalse(card().holds(equals))
        assertTrue(card().holds(differs))
        assertFalse(card().holds(whenIs("allDay", flag(true))))
        val allDay = card(userValues = mapOf("primary.allDay" to flag(true)))
        assertTrue(allDay.isTimeHidden(allDay.fieldOf("date")))
        assertFalse(card().isTimeHidden(card().fieldOf("date")))
    }

    @Test fun `the groups are the schema and a group without a visible field is dropped`() {
        assertEquals(listOf("main", "links"), card().visibleGroups().map { it.key })
        assertEquals(
            listOf("name", "date", "allDay", "status", "project", "company"),
            card().visibleFields().map { it.key },
        )
    }

    @Test fun `each kind of card brings the editor it needs`() {
        assertTrue(card(kind = InboxCardKind.APPROVAL).editorGroups().isEmpty())
        assertTrue(card(kind = InboxCardKind.UNSUPPORTED).editorGroups().isEmpty())
        assertEquals(listOf("who"), card(kind = InboxCardKind.SPEAKER).visibleFields().map { it.key })
        assertEquals(listOf("type"), card(kind = InboxCardKind.CLARIFY).visibleFields().map { it.key })
        assertEquals(
            listOf("name", "language", "eventId", "projectId"),
            card(kind = InboxCardKind.RECORDING, schema = null).visibleFields().map { it.key },
        )
        val link = card(kind = InboxCardKind.TRANSCRIPT_EVENT, envelope = envelope(kind = InboxEntityKind.RELATION))
        assertEquals(listOf("match"), link.visibleFields().map { it.key })
        val newMeeting = card(kind = InboxCardKind.TRANSCRIPT_EVENT)
        assertEquals("match", newMeeting.visibleFields().first().key)
        assertTrue(newMeeting.visibleFields().size > 1)
    }

    @Test fun `a card is ready only when nothing it needs is missing`() {
        assertEquals(InboxReadiness.READY, card().readiness())
        val blank = card(envelope = envelope(mapOf("name" to text("  "))))
        assertEquals(InboxReadiness.MISSING_FIELDS, blank.readiness())
        assertEquals(listOf("name"), blank.missingFields().map { it.key })
        assertEquals(InboxReadiness.COMPUTING, card(status = InboxCardStatus.COMPUTING).readiness())
        assertEquals(InboxReadiness.COMPUTE_FAILED, card(status = InboxCardStatus.COMPUTE_FAILED).readiness())
        assertEquals(InboxReadiness.INVALID, card(status = InboxCardStatus.INVALID).readiness())
        assertEquals(InboxReadiness.UNSUPPORTED, card(kind = InboxCardKind.UNSUPPORTED).readiness())
        val approval = card(kind = InboxCardKind.APPROVAL, status = InboxCardStatus.PENDING)
        assertEquals(InboxReadiness.READY, approval.readiness())
    }

    @Test fun `a hidden required field is not missing and a visible one is`() {
        val switchedOff = step("follow", primary = false, enabled = false)
        val off = card(envelope = envelope(steps = listOf(followSteps[0], switchedOff)))
        assertEquals(InboxReadiness.READY, off.readiness())
        val noDate = step("follow", primary = false).copy(properties = emptyMap())
        val on = card(envelope = envelope(steps = listOf(followSteps[0], noDate)))
        assertEquals(listOf("followDate"), on.missingFields().map { it.key })
    }

    @Test fun `a card of a choice needs the choice and a card of a type needs the type`() {
        val speaker = card(kind = InboxCardKind.SPEAKER, envelope = null)
        assertEquals(InboxReadiness.MISSING_FIELDS, speaker.readiness())
        val chosen = card(
            kind = InboxCardKind.SPEAKER,
            envelope = envelope(kind = InboxEntityKind.RELATION, target = "person-1"),
        )
        assertEquals(InboxReadiness.READY, chosen.readiness())
        val clarify = card(kind = InboxCardKind.CLARIFY, status = InboxCardStatus.NEEDS_CLARIFICATION, envelope = null)
        assertEquals(InboxReadiness.MISSING_FIELDS, clarify.readiness())
        assertEquals(InboxReadiness.READY, clarify.readiness(InboxAnswers(typeId = "t1")))
        assertEquals(InboxReadiness.READY, card(kind = InboxCardKind.TRANSCRIPT_EVENT).readiness())
    }

    @Test fun `a secret is answered by the person and the file of a file card is never missing`() {
        val required = { key: String, control: InboxControl -> InboxField(key, control, required = true) }
        val mcp = card(
            kind = InboxCardKind.MCP,
            schema = InboxSchema("mcp", listOf(InboxGroup("g", listOf(required("credential", InboxControl.SECRET))))),
            envelope = envelope(emptyMap()),
        )
        assertEquals(InboxReadiness.MISSING_FIELDS, mcp.readiness())
        assertEquals(InboxReadiness.READY, mcp.readiness(InboxAnswers(secret = "k")))
        val file = card(
            kind = InboxCardKind.FILE,
            schema = InboxSchema("file", listOf(InboxGroup("g", listOf(required("file", InboxControl.TILE))))),
        )
        assertEquals(InboxReadiness.READY, file.readiness())
    }

    @Test fun `text a switch and a date are written under the key of the field`() {
        val c = card()
        assertEquals(mapOf("name" to text("New")), c.primary("name", InboxInput.Text("New")))
        assertEquals(mapOf("allDay" to flag(true)), c.primary("allDay", InboxInput.Flag(true)))
        assertEquals(mapOf("date" to text("2026-11-01")), c.primary("date", InboxInput.Date("2026-11-01")))
    }

    @Test fun `the time of a date and time field is the start time of the destination`() {
        assertEquals(mapOf("timeFrom" to text("14:30")), card().primary("date", InboxInput.Time("14:30")))
    }

    @Test fun `an item select writes a relation list when the destination has the relation`() {
        val c = card(properties = relation("project"))
        val project = c.edit("project", pick("p2"))
        assertEquals(mapOf("primary" to mapOf("project" to listOf("p2"))), project.relations)
        assertTrue(project.values.isEmpty())
        assertEquals(mapOf("primary" to mapOf("project" to emptyList())), c.edit("project", pick(null)).relations)
    }

    @Test fun `an item select writes the id when the destination has no relation of that key`() {
        val company = card(properties = relation("project")).edit("company", pick("c1"))
        assertEquals(mapOf("primary" to mapOf("company" to text("c1"))), company.values)
        assertTrue(company.relations.isEmpty())
    }

    @Test fun `a relation the proposal already holds is a relation even when the schema is unknown`() {
        val c = card(envelope = envelope(relations = mapOf("project" to listOf("p1"))))
        assertEquals(mapOf("primary" to mapOf("project" to listOf("p2"))), c.edit("project", pick("p2")).relations)
    }

    @Test fun `a select of options writes the key of the option and a multi value the ids`() {
        val c = card()
        assertEquals(mapOf("status" to text("done")), c.primary("status", pick("done")))
        assertEquals(
            mapOf("status" to InboxValue.Items(listOf("a", "b"))),
            c.primary("status", InboxInput.Many(listOf("a", "b"))),
        )
        val related = card(properties = relation("status"))
        val many = related.edit("status", InboxInput.Many(listOf("a")))
        assertEquals(mapOf("primary" to mapOf("status" to listOf("a"))), many.relations)
    }

    @Test fun `the follow up task is a step switch and its date is a value of that step`() {
        val c = card(envelope = envelope(steps = followSteps))
        assertEquals(mapOf("follow" to false), c.edit("followupTask", InboxInput.Flag(false)).steps)
        val date = c.edit("followDate", InboxInput.Date("2026-11-02"))
        assertEquals(mapOf("follow" to mapOf("date" to text("2026-11-02"))), date.values)
        assertEquals(InboxChange.None, c.change(c.fieldOf("followupTask"), InboxInput.Text("x")))
        val field = InboxField("followupTask", InboxControl.TOGGLE)
        assertEquals(InboxChange.None, card().change(field, InboxInput.Flag(true)))
    }

    @Test fun `the values of a multi step card are written under its primary step`() {
        val c = card(envelope = envelope(steps = followSteps))
        assertEquals(setOf("main"), c.edit("name", InboxInput.Text("New")).values.keys)
    }

    @Test fun `the page of a text is a new proposal of the card and only a page content card has one`() {
        val pageField = InboxField("page", InboxControl.SELECT, optionsSource = "page")
        val schema = InboxSchema("page", listOf(InboxGroup("g", listOf(pageField))))
        val markdown = mapOf("markdown" to text("# Hi"))
        val page = card(
            kind = InboxCardKind.PAGE,
            envelope = envelope(markdown, kind = InboxEntityKind.PAGE_CONTENT, target = "p1"),
            schema = schema,
        )
        val change = page.change(page.fieldOf("page"), pick("p2"))
        val revision = assertIs<InboxRevision.Page>(assertIs<InboxChange.Revise>(change).revision)
        assertEquals("p2", revision.target)
        assertEquals(markdown, revision.properties)
        assertEquals(InboxChange.None, page.change(page.fieldOf("page"), pick(null)))
        assertEquals(InboxChange.None, page.change(page.fieldOf("page"), InboxInput.Text("x")))
        val database = card(schema = schema)
        assertEquals(InboxChange.None, database.change(database.fieldOf("page"), pick("p2")))
    }

    @Test fun `a recording writes its event with whether there is none and a language auto as none`() {
        val c = card(kind = InboxCardKind.RECORDING, schema = null, envelope = envelope(mapOf("name" to text("Call"))))
        assertEquals(
            mapOf("eventId" to text("e1"), "noEvent" to flag(false)),
            c.primary("eventId", pick("e1")),
        )
        assertEquals(mapOf("eventId" to null, "noEvent" to flag(true)), c.primary("eventId", pick(null)))
        assertEquals(mapOf("language" to null), c.primary("language", pick("auto")))
        assertEquals(mapOf("language" to text("cs")), c.primary("language", pick("cs")))
    }

    @Test fun `edits of one step merge and later values win`() {
        val a = InboxEdit(
            values = mapOf("primary" to mapOf("a" to text("1"), "b" to text("1"))),
            steps = mapOf("s" to true),
        )
        val b = InboxEdit(
            values = mapOf("primary" to mapOf("b" to text("2"))),
            relations = mapOf("primary" to mapOf("r" to listOf("x"))),
        )
        val merged = a + b
        assertEquals(mapOf("a" to text("1"), "b" to text("2")), merged.values["primary"])
        assertEquals(mapOf("s" to true), merged.steps)
        assertEquals(listOf("x"), merged.relations["primary"]?.get("r"))
        assertTrue(InboxEdit().isEmpty)
        assertFalse(a.isEmpty)
    }

    @Test fun `an edited field is one the server lists as edited under the primary step`() {
        val c = card().copy(editedKeys = setOf("primary.name", "primary.relations.project", "primary.allDay"))
        assertTrue(c.isEdited("name"))
        assertTrue(c.isEdited("project"))
        assertTrue(c.isEdited("allDay"))
        assertFalse(c.isEdited("status"))
    }

    @Test fun `a select knows its options without the server unless it asks for items`() {
        val statusOptions = listOf(InboxChoice("todo", "To do"))
        val info = InboxPropertyInfo("status", InboxPropertyType.SELECT, statusOptions)
        val c = card(properties = mapOf("status" to info))
        assertEquals(listOf("todo"), c.optionsOf(c.fieldOf("status"))!!.map { it.id })
        assertNull(c.optionsOf(c.fieldOf("project")))
        val seg = InboxField("placement", InboxControl.SEG, options = listOf("start", "end"))
        assertEquals(listOf("start", "end"), c.optionsOf(seg)!!.map { it.id })
        assertEquals(emptyList(), c.optionsOf(InboxField("allDay", InboxControl.TOGGLE)))
    }

    @Test fun `a recording may belong to the events it overlaps or to none`() {
        val recording = card(
            kind = InboxCardKind.RECORDING,
            schema = null,
            context = InboxContext.Recording(listOf(InboxCandidate("e1", "Sprint", date = "2026-10-14"))),
        )
        val events = recording.optionsOf(recording.fieldOf("eventId"))!!
        assertEquals(listOf("e1", null), events.map { it.id })
        assertTrue(events.last().none)
    }

    @Test fun `a speaker is one of the people the producer proposed`() {
        val people = listOf(InboxCandidate("pe1", "Jana", "Designer"))
        val speaker = card(
            kind = InboxCardKind.SPEAKER,
            envelope = envelope(kind = InboxEntityKind.RELATION, target = "pe1"),
            context = InboxContext.Speaker("S3", 3, emptyList(), "r", people),
        )
        val who = speaker.fieldOf("who")
        assertEquals(listOf("pe1"), speaker.choicesOf(who, emptyList()).map { it.id })
        assertEquals("pe1", speaker.chosenId(who))
        assertEquals(
            InboxRevision.LinkSpeaker("pe2", "S3"),
            speaker.revisionOf(who, InboxChoice("pe2", "Petr")),
        )
        assertNull(speaker.revisionOf(who, InboxChoice(null, "", none = true)))
    }

    @Test fun `a recording of a meeting is one of the events and the recommended one is marked`() {
        val events = listOf(InboxCandidate("e1", "A"), InboxCandidate("e2", "B"))
        val meeting = card(
            kind = InboxCardKind.TRANSCRIPT_EVENT,
            envelope = envelope(kind = InboxEntityKind.RELATION, target = "e2"),
            context = InboxContext.Meeting(events, "e2", null),
        )
        val match = meeting.fieldOf("match")
        assertEquals(listOf(false, true), meeting.choicesOf(match, emptyList()).map { it.suggested })
        assertEquals(InboxRevision.LinkEvent("e1"), meeting.revisionOf(match, InboxChoice("e1", "A")))
        assertNull(meeting.chosenId(InboxField("other", InboxControl.TEXT)))
    }

    @Test fun `a capture that needs clarifying offers the types and is no revision`() {
        val clarify = card(kind = InboxCardKind.CLARIFY, envelope = null)
        val types = listOf(InboxType("t1", "Task", "T", "Tasks"))
        val type = clarify.fieldOf("type")
        assertEquals(listOf("t1"), clarify.choicesOf(type, types).map { it.id })
        assertNull(clarify.revisionOf(type, InboxChoice("t1", "Task")))
    }
}
