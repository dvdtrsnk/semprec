package cz.semprec.app.data

import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.InboxApproval
import cz.semprec.app.domain.InboxCandidate
import cz.semprec.app.domain.InboxCard
import cz.semprec.app.domain.InboxCardKind
import cz.semprec.app.domain.InboxCardStatus
import cz.semprec.app.domain.InboxChoice
import cz.semprec.app.domain.InboxCondition
import cz.semprec.app.domain.InboxContext
import cz.semprec.app.domain.InboxControl
import cz.semprec.app.domain.InboxEntityKind
import cz.semprec.app.domain.InboxEnvelope
import cz.semprec.app.domain.InboxField
import cz.semprec.app.domain.InboxGroup
import cz.semprec.app.domain.InboxInputType
import cz.semprec.app.domain.InboxInvalid
import cz.semprec.app.domain.InboxOrigin
import cz.semprec.app.domain.InboxPropertyInfo
import cz.semprec.app.domain.InboxPropertyType
import cz.semprec.app.domain.InboxSchema
import cz.semprec.app.domain.InboxTarget
import cz.semprec.app.domain.InboxValue
import cz.semprec.app.domain.PropertyKind
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

private val KINDS = mapOf(
    "task" to InboxCardKind.TASK,
    "event" to InboxCardKind.EVENT,
    "page" to InboxCardKind.PAGE,
    "journal" to InboxCardKind.JOURNAL,
    "project" to InboxCardKind.PROJECT,
    "company" to InboxCardKind.COMPANY,
    "person" to InboxCardKind.PERSON,
    "health" to InboxCardKind.HEALTH,
    "file" to InboxCardKind.FILE,
    "recording" to InboxCardKind.RECORDING,
    "mcp" to InboxCardKind.MCP,
    "invalid" to InboxCardKind.INVALID,
    "clarify" to InboxCardKind.CLARIFY,
    "transcriptEvent" to InboxCardKind.TRANSCRIPT_EVENT,
    "speaker" to InboxCardKind.SPEAKER,
    "approval" to InboxCardKind.APPROVAL,
)

private val STATUSES = mapOf(
    "proposed" to InboxCardStatus.PROPOSED,
    "computing" to InboxCardStatus.COMPUTING,
    "computeFailed" to InboxCardStatus.COMPUTE_FAILED,
    "needsClarification" to InboxCardStatus.NEEDS_CLARIFICATION,
    "invalid" to InboxCardStatus.INVALID,
    "pending" to InboxCardStatus.PENDING,
)

private val CONTROLS = mapOf(
    "text" to InboxControl.TEXT,
    "area" to InboxControl.AREA,
    "date" to InboxControl.DATE,
    "datetime" to InboxControl.DATETIME,
    "select" to InboxControl.SELECT,
    "multi" to InboxControl.MULTI,
    "toggle" to InboxControl.TOGGLE,
    "seg" to InboxControl.SEG,
    "color" to InboxControl.COLOR,
    "secret" to InboxControl.SECRET,
    "info" to InboxControl.INFO,
    "choice" to InboxControl.CHOICE,
    "tile" to InboxControl.TILE,
)

private val INPUT_TYPES = mapOf(
    "email" to InboxInputType.EMAIL,
    "url" to InboxInputType.URL,
    "tel" to InboxInputType.TEL,
)

/**
 * The card as the list answers it, with what the target database says of its properties and, for an approval, what
 * the request asks for. A card whose kind or status this app does not know is [InboxCardKind.UNSUPPORTED], which can
 * only be discarded; a transcript card that asks for clarification is presented as the choice it is.
 */
internal fun InboxCardDto.toCard(schema: CollectionSchema?, approval: InboxApproval?): InboxCard {
    val parsed = envelope.toEnvelope()
    val status = STATUSES[status]
    val context = context.toContext()
    return InboxCard(
        id = cardId,
        kind = presentedKind(KINDS[cardKind], status, context),
        baseKind = KINDS[baseKind] ?: InboxCardKind.UNSUPPORTED,
        status = status ?: InboxCardStatus.PROPOSED,
        version = version,
        origin = resolvedSource?.toOrigin(),
        targets = targets.map { InboxTarget(it.databaseKey, it.label) },
        envelope = parsed,
        schema = editorSchema?.toSchema(),
        invalid = invalidReason?.let { InboxInvalid(it.code, it.field, it.text) },
        approval = approval,
        context = context,
        properties = propertiesOf(schema, parsed),
        timedOut = computeTimedOut,
    )
}

private fun presentedKind(kind: InboxCardKind?, status: InboxCardStatus?, context: InboxContext): InboxCardKind = when {
    kind == null || status == null -> InboxCardKind.UNSUPPORTED
    kind == InboxCardKind.CLARIFY && context is InboxContext.Speaker -> InboxCardKind.SPEAKER
    kind == InboxCardKind.CLARIFY && context is InboxContext.Meeting -> InboxCardKind.TRANSCRIPT_EVENT
    else -> kind
}

private fun InboxSourceDto.toOrigin(): InboxOrigin? = when (kind) {
    "inboxItem" -> InboxOrigin.Capture(id.orEmpty(), text, date, time, type?.name, type?.emoji)
    "transcript" -> InboxOrigin.Transcript(name, completedAt)
    "run" -> InboxOrigin.Run(sourceKind.orEmpty(), threadTitle, heartbeatName, mcpClientName)
    else -> null
}

internal fun InboxSchemaDto.toSchema(): InboxSchema = InboxSchema(
    baseKind = baseKind,
    groups = groups.map { group -> InboxGroup(group.key, group.fields.mapNotNull { it.toField() }) },
)

/** A field of a control this app does not know is left out: a newer server may declare more than the app draws. */
private fun InboxFieldDto.toField(): InboxField? {
    val control = CONTROLS[control] ?: return null
    return InboxField(
        key = key,
        control = control,
        inputType = INPUT_TYPES[inputType] ?: InboxInputType.TEXT,
        label = label,
        placeholder = placeholder,
        required = required,
        whenHolds = `when`?.toCondition(),
        timeHiddenWhen = timeHiddenWhen?.toCondition(),
        optionsSource = optionsSource,
        options = options,
        info = info,
    )
}

private fun InboxConditionDto.toCondition(): InboxCondition? {
    val wanted = (equals ?: notEquals) as? JsonPrimitive
    val value = wanted?.let { primitive ->
        primitive.booleanOrNull?.takeIf { !primitive.isString }?.let { InboxValue.Flag(it) }
            ?: primitive.contentOrNull?.let { InboxValue.Text(it) }
    }
    return value?.let { InboxCondition(field, it, negated = equals == null) }
}

/** What the target database says of its select and relation properties; none for a card that writes no row. */
private fun propertiesOf(schema: CollectionSchema?, envelope: InboxEnvelope?): Map<String, InboxPropertyInfo> {
    val database = when (envelope?.entityKind) {
        InboxEntityKind.DATABASE -> schema?.databaseById(envelope.target)
        else -> envelope?.steps?.firstOrNull { it.primary }?.databaseKey?.let { schema?.database(it) }
    }
    return database?.properties.orEmpty().associate { property ->
        val type = when (property.kind) {
            PropertyKind.RELATION -> InboxPropertyType.RELATION
            PropertyKind.SELECT, PropertyKind.COLOR -> InboxPropertyType.SELECT
            else -> InboxPropertyType.OTHER
        }
        property.key to InboxPropertyInfo(
            key = property.key,
            type = type,
            options = property.options.map { InboxChoice(id = it.key, label = it.label, color = it.color) },
        )
    }
}

/** What the producer of a transcript or recording card put beside the proposal; any other card has none. */
internal fun JsonElement?.toContext(): InboxContext {
    val root = this as? JsonObject ?: return InboxContext.None
    return when (root.text("role")) {
        "recording" -> InboxContext.Recording(root.candidates("candidates", "eventId"))
        "event" -> InboxContext.Meeting(
            candidates = root.candidates("candidates", "id"),
            recommended = root.text("recommendedEventId"),
            reason = root.text("reason"),
        )
        "speaker" -> root.toSpeaker()
        else -> InboxContext.None
    }
}

private fun JsonObject.toSpeaker(): InboxContext {
    val speaker = text("speaker") ?: return InboxContext.None
    val quotes = (this["quotes"] as? JsonArray).orEmpty().mapNotNull {
        (it as? JsonObject)?.text("text")
    }
    val alternatives = (this["alternatives"] as? JsonArray).orEmpty().mapNotNull {
        val person = it as? JsonObject ?: return@mapNotNull null
        val id = person.text("personId") ?: return@mapNotNull null
        InboxCandidate(id = id, label = person.text("name").orEmpty(), detail = person.text("title"))
    }
    return InboxContext.Speaker(
        speaker = speaker,
        ordinal = (this["ordinal"] as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 0,
        quotes = quotes,
        reason = text("reason").orEmpty(),
        alternatives = alternatives,
    )
}

/** The events of a card: a stored one by [idKey], a virtual occurrence of a series as `series@date`. */
private fun JsonObject.candidates(key: String, idKey: String): List<InboxCandidate> =
    (this[key] as? JsonArray).orEmpty().mapNotNull { element ->
        val event = element as? JsonObject ?: return@mapNotNull null
        val series = event.text("seriesId")
        val occurrence = event.text("occurrenceDate")
        when {
            series != null && occurrence != null ->
                InboxCandidate(id = "$series@$occurrence", label = "", date = occurrence)
            else -> event.text(idKey)?.let {
                InboxCandidate(
                    id = it,
                    label = event.text("name").orEmpty(),
                    detail = event.text("projectName"),
                    date = event.text("date"),
                    timeFrom = event.text("timeFrom"),
                    timeTo = event.text("timeTo"),
                )
            }
        }
    }
