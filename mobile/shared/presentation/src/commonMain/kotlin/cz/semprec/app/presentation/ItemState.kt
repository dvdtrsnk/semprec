package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class ItemPhase { LOADING, CONTENT, ERROR }

/** The item and the collection it belongs to; names and colors are in the language of the signed-in person. */
data class ItemHeader(
    val itemId: String,
    val databaseId: String,
    val databaseKey: String?,
    val databaseName: String,
    val icon: String?,
    val color: String?,
    val title: String,
)

/** A collection connected to the item: [count] items of one database, openable as a collection. */
data class RelatedView(
    val databaseId: String,
    val databaseKey: String?,
    val name: String,
    val icon: String?,
    val color: String?,
    val count: Int,
)

enum class PageStatus { LOADING, READY, SAVING, CONFLICT, ERROR }

/** The item's own document as Markdown; [failure] explains [PageStatus.ERROR], and `null` there is unexpected. */
data class PageView(val status: PageStatus, val markdown: String, val failure: FailureKind?)

enum class PreviewStatus { LOADING, READY, ERROR }

/** A downloaded file shown in full; [base64] holds its bytes once [status] is [PreviewStatus.READY]. */
data class PreviewView(
    val blobId: String,
    val filename: String?,
    val mimeType: String,
    val status: PreviewStatus,
    val base64: String?,
    val failure: FailureKind?,
)

/** Items a relation can be pointed at, found by a search of the target database. */
data class PickerView(
    val propertyKey: String,
    val name: String,
    val loading: Boolean,
    val failure: Failed?,
    val candidates: List<TargetView>,
)

data class ImpactEntry(val databaseKey: String?, val count: Int)

/** What deleting the item reaches, to be stated before it is confirmed. */
data class ImpactView(
    val related: List<ImpactEntry>,
    val nestedItems: Int,
    val nestedPages: Int,
    val takenOverValues: Int,
    val seriesInstances: Int,
    val attachments: Int,
    val hostEvents: Int,
)

/** The delete confirmation: it first reads the impact, then waits for the person. */
data class DeletionView(val loading: Boolean, val failure: Failed?, val impact: ImpactView?, val deleting: Boolean)

/** A write that did not go through; [kind] is `null` for an unexpected failure. */
data class ItemWriteFailure(val propertyKey: String?, val kind: FailureKind?)

/**
 * Everything one item detail shows. [saving] is true while a write is in flight; [deleted] once the item is gone.
 * [writeFailure] is the last write that failed; [choiceFailure] is the last new choice ([ItemAction.Edit.AddChoice])
 * that could not be added and set, kept apart so that only the place that adds choices shows it. The next write
 * clears both.
 */
data class ItemState(
    val phase: ItemPhase = ItemPhase.LOADING,
    val failure: FailureKind? = null,
    val header: ItemHeader? = null,
    val fields: List<FieldView> = emptyList(),
    val related: List<RelatedView> = emptyList(),
    val page: PageView = PageView(PageStatus.LOADING, "", null),
    val preview: PreviewView? = null,
    val picker: PickerView? = null,
    val deletion: DeletionView? = null,
    val saving: Boolean = false,
    val writeFailure: ItemWriteFailure? = null,
    val choiceFailure: ItemWriteFailure? = null,
    val deleted: Boolean = false,
)
