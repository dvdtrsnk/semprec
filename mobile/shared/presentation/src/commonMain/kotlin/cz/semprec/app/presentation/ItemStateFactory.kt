package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.ItemDetail

/** The state of a loaded item; what is open on top of it (page, preview, picker, deletion) carries over. */
internal fun itemState(detail: ItemDetail, previous: ItemState): ItemState {
    val database = detail.database
    val title = (database.title?.let { detail.item.values[it.key] } as? FieldValue.Text)?.text.orEmpty()
    return previous.copy(
        phase = ItemPhase.CONTENT,
        failure = null,
        header = ItemHeader(
            itemId = detail.item.id,
            databaseId = database.id,
            databaseKey = database.key,
            databaseName = database.name,
            icon = database.icon,
            color = database.color,
            title = title,
        ),
        fields = detail.item.fieldViews(database),
        related = detail.related.map {
            RelatedView(it.database.id, it.database.key, it.database.name, it.database.icon, it.database.color, it.count)
        },
        saving = false,
    )
}

internal fun itemFailure(kind: FailureKind?) = ItemState(phase = ItemPhase.ERROR, failure = kind)

internal fun DeleteImpact.toView() = ImpactView(
    related = related.map { ImpactEntry(it.databaseKey, it.count) },
    nestedItems = nestedItems,
    nestedPages = nestedPages,
    takenOverValues = takenOverValues,
    seriesInstances = seriesInstances,
    attachments = attachments,
    hostEvents = hostEvents,
)
