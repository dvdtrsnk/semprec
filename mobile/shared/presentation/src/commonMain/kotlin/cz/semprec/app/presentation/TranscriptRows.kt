package cz.semprec.app.presentation

import cz.semprec.app.domain.TranscriptCandidate
import cz.semprec.app.domain.TranscriptContextValue
import cz.semprec.app.domain.TranscriptDetail
import cz.semprec.app.domain.activeAt
import cz.semprec.app.domain.matching

/** The state a freshly read [detail] gives, over what the person already chose in [current] (tab, query, menu). */
internal fun TranscriptDetail.toState(current: TranscriptState): TranscriptState {
    val busy = current.actionItems.filter { it.busy }.map { it.id }.toSet()
    return current.copy(
        phase = TranscriptPhase.CONTENT,
        failure = null,
        title = name,
        date = date,
        durationSeconds = durationSeconds,
        language = language,
        status = status,
        eventId = event?.id,
        eventName = event?.name,
        project = context.project?.toItem(),
        company = context.company?.toItem(),
        people = context.people.map { it.toItem() },
        summary = notes?.summary?.takeIf { it.isNotBlank() },
        decisions = notes?.decisions.orEmpty(),
        actionItems = notes?.actionItems.orEmpty().map {
            TranscriptActionRow(it.id, it.text, it.ownerLabel, it.due, it.state, it.isMine, it.id in busy)
        },
    ).withSegments(this)
}

/** The segments the query keeps, with the one being spoken at the player's position marked. */
internal fun TranscriptState.withSegments(detail: TranscriptDetail): TranscriptState {
    val mapped = detail.speakers.filter { it.personId != null }.map { it.key }.toSet()
    val active = detail.segments.activeAt(player.position).takeIf { player.available }
    val shown = detail.segments.matching(query)
    return copy(
        segments = shown.map {
            TranscriptSegmentRow(
                it.index,
                it.speaker,
                it.label,
                it.text,
                it.startsAt,
                it.speaker in mapped,
                it.index == active,
            )
        },
        matchCount = shown.size,
    )
}

internal fun List<TranscriptCandidate>.toRows(speaker: String): List<TranscriptCandidateRow> =
    map { TranscriptCandidateRow(it.personId, it.name, it.mappedSpeaker == speaker) }

private fun TranscriptContextValue.toItem() = TranscriptContextItem(id, name, inherited)
