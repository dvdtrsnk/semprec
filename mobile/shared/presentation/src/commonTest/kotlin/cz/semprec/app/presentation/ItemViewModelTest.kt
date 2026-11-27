package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.Author
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.ImpactCollection
import cz.semprec.app.domain.OriginSource
import cz.semprec.app.domain.PageContent
import cz.semprec.app.domain.RelatedCollection
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.ValueKind
import cz.semprec.app.domain.ValueOrigin
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ItemViewModelTest : MainDispatcherTest() {
    private val fake = FakeCollections()
    private val factory = CollectionViewModelFactory(fake, fake)

    private val origins = mapOf(
        "status" to ValueOrigin(
            ValueKind.INHERITED, listOf(OriginSource("t1", "tasks", "Odeslat fakturu", "status")),
            null
        ),
        "date" to ValueOrigin(
            ValueKind.INHERITED_BROKEN,
            listOf(
                OriginSource(
                    "t1", "tasks", "Odeslat fakturu",
                    "date"
                )
            ),
            Author.AGENT
        ),
        "people" to ValueOrigin(ValueKind.DERIVED, listOf(OriginSource("p1", "projects", "", null)), null),
    )
    private val project = projectItem(
        "p1",
        "Semprec iOS",
        date = "2027-01-31",
        person = "Work",
        extra = mapOf(
            "pinned" to FieldValue.Flag(true),
            "budget" to FieldValue.Number(1000.0),
            "completedAt" to FieldValue.Text("2026-10-01"),
        ),
        origins = origins,
    )

    private fun TestScope.open(hint: String? = "projects", id: String = "p1"): ItemViewModel {
        val vm = factory.itemViewModel(id, hint)
        runCurrent()
        return vm
    }

    private fun arrange() {
        fake.itemAnswer = { RepositoryResult.Content(project) }
        fake.relatedAnswer = {
            RepositoryResult.Content(
                listOf(
                    RelatedCollection("files", FILES, 3, FilterTree("""{"type":"relation_contains"}""")),
                    RelatedCollection("unknown", "db-unknown", 9, null),
                ),
            )
        }
    }

    private fun ItemState.field(key: String) = fields.single { it.propertyKey == key }

    @Test fun `starts loading then shows the item its properties related collections and page`() = runTest(dispatcher) {
        arrange()
        fake.pageAnswer = { RepositoryResult.Content(PageContent("# Notes", "e7")) }
        val vm = factory.itemViewModel("p1", "projects")
        assertEquals(ItemState(), vm.state.value)
        runCurrent()
        val state = vm.state.value
        assertEquals(ItemPhase.CONTENT, state.phase)
        assertEquals(
            ItemHeader("p1", PROJECTS, "projects", "Projects", "folder", "#AF52DE", "Semprec iOS"),
            state.header
        )
        assertEquals(
            listOf("status", "date", "people", "company", "pinned", "tags", "budget", "note", "completedAt"),
            state.fields.map { it.propertyKey },
        )
        assertEquals(listOf(RelatedView(FILES, "files", "Files", "doc", "#636366", 3)), state.related)
        assertEquals(PageView(PageStatus.READY, "# Notes", null), state.page)
        assertEquals(listOf("item:p1:company,people"), fake.calls)
        vm.close()
    }

    @Test fun `every property is shown by its kind with its value and the choices of a select`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        val state = vm.state.value
        val status = state.field("status")
        assertEquals(FieldKind.SELECT, status.kind)
        assertEquals(FieldContent.Choices(listOf(OptionView("inProgress", "In progress", "#007AFF"))), status.content)
        assertEquals(3, status.options.size)
        assertEquals(FieldContent.Day("2027-01-31"), state.field("date").content)
        assertEquals(FieldContent.Flag(true), state.field("pinned").content)
        assertEquals(FieldContent.Number(1000.0), state.field("budget").content)
        assertEquals(FieldContent.Empty, state.field("tags").content)
        assertEquals(FieldContent.Empty, state.field("company").content)
        assertEquals(FieldKind.RELATION, state.field("company").kind)
        assertTrue(state.field("tags").editable)
        assertFalse(state.field("completedAt").editable)
        assertTrue(state.fields.none { it.propertyKey == "tasks" })
        vm.close()
    }

    @Test fun `an unknown hint reads the item twice and an empty system property is hidden`() = runTest(dispatcher) {
        arrange()
        val vm = open(hint = null)
        assertEquals(listOf("item:p1:", "item:p1:company,people"), fake.calls)
        assertTrue(vm.state.value.fields.any { it.propertyKey == "completedAt" })
        vm.close()
        val bare = FakeCollections().also { it.itemAnswer = { RepositoryResult.Content(projectItem("p2", "P2")) } }
        val vm2 = CollectionViewModelFactory(bare, bare).itemViewModel("p2", "projects")
        runCurrent()
        assertTrue(vm2.state.value.fields.none { it.propertyKey == "completedAt" })
        vm2.close()
    }

    @Test fun `a value taken from another item shows where it comes from`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        val state = vm.state.value
        val inherited = assertNotNull(state.field("status").origin)
        assertEquals(OriginKind.INHERITED, inherited.kind)
        assertEquals(listOf(OriginSourceView("t1", "tasks", "Odeslat fakturu")), inherited.sources)
        assertNull(inherited.brokenBy)
        val broken = assertNotNull(state.field("date").origin)
        assertEquals(OriginKind.INHERITED_BROKEN, broken.kind)
        assertEquals(OriginAuthor.AGENT, broken.brokenBy)
        val derived = assertNotNull(state.field("people").origin)
        assertEquals(OriginKind.DERIVED, derived.kind)
        assertFalse(state.field("people").editable)
        assertTrue(state.field("status").editable)
        assertNull(state.field("pinned").origin)
        vm.close()
    }

    @Test fun `a user value that was broken by the user keeps no author`() = runTest(dispatcher) {
        val mine = project.copy(
            origins = mapOf(
                "status" to ValueOrigin(
                    ValueKind.INHERITED_BROKEN, emptyList(),
                    Author.USER
                )
            )
        )
        fake.itemAnswer = { RepositoryResult.Content(mine) }
        val vm = open()
        assertEquals(OriginAuthor.USER, vm.state.value.field("status").origin?.brokenBy)
        vm.close()
    }

    @Test fun `a missing item is not found and an unexpected exception has no kind`() = runTest(dispatcher) {
        val vm = open()
        assertEquals(ItemState(phase = ItemPhase.ERROR, failure = FailureKind.NOT_FOUND), vm.state.value)
        fake.itemAnswer = { throw IllegalStateException("boom") }
        vm.onAction(ItemAction.Retry)
        assertEquals(ItemState(), vm.state.value)
        runCurrent()
        assertEquals(ItemState(phase = ItemPhase.ERROR), vm.state.value)
        arrange()
        vm.onAction(ItemAction.Retry)
        runCurrent()
        assertEquals(ItemPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an item of a database the schema lacks is invalid data`() = runTest(dispatcher) {
        fake.itemAnswer = { RepositoryResult.Content(project.copy(databaseId = "db-unknown")) }
        val vm = open()
        assertEquals(FailureKind.INVALID_DATA, vm.state.value.failure)
        vm.close()
    }

    @Test fun `a failed related read does not fail the item`() = runTest(dispatcher) {
        arrange()
        fake.relatedAnswer = { failure(FailureKind.UNAVAILABLE) }
        val vm = open()
        assertEquals(ItemPhase.CONTENT, vm.state.value.phase)
        assertEquals(emptyList(), vm.state.value.related)
        vm.close()
    }

    @Test fun `renaming writes the title with the version of the item and reads it again`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        val gate = CompletableDeferred<Unit>()
        fake.updateAnswer = {
            gate.await()
            RepositoryResult.Content(project)
        }
        vm.onAction(ItemAction.Edit.Rename("  New name "))
        assertTrue(vm.state.value.saving)
        gate.complete(Unit)
        runCurrent()
        assertEquals(
            listOf(Triple("p1", "v-p1", mapOf<String, FieldValue?>("name" to FieldValue.Text("New name")))),
            fake.updates
        )
        assertFalse(vm.state.value.saving)
        assertEquals(2, fake.itemReads)
        vm.onAction(ItemAction.Edit.Rename("   "))
        runCurrent()
        assertEquals(1, fake.updates.size)
        vm.close()
    }

    @Test fun `a new name with line breaks is written on one line`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Edit.Rename("New\nname\n"))
        runCurrent()
        assertEquals(mapOf<String, FieldValue?>("name" to FieldValue.Text("New name")), fake.updates.single().third)
        vm.close()
    }

    @Test fun `each kind of value is written in its own shape and an empty one clears it`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Edit.SetText("note", " hello "))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetText("note", ""))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetNumber("budget", 5.5))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetNumber("budget", null))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetFlag("pinned", false))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetChoices("status", listOf("done")))
        runCurrent()
        vm.onAction(ItemAction.Edit.SetChoices("tags", emptyList()))
        runCurrent()
        assertEquals(
            listOf(
                mapOf<String, FieldValue?>("note" to FieldValue.Text("hello")),
                mapOf("note" to null),
                mapOf("budget" to FieldValue.Number(5.5)),
                mapOf("budget" to null),
                mapOf("pinned" to FieldValue.Flag(false)),
                mapOf("status" to FieldValue.Choices(listOf("done"))),
                mapOf("tags" to null),
            ),
            fake.updates.map { it.third },
        )
        vm.close()
    }

    @Test fun `a property the person cannot edit is refused without a request`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Edit.SetText("completedAt", "2026-01-01"))
        assertEquals(ItemWriteFailure("completedAt", FailureKind.REJECTED), vm.state.value.writeFailure)
        vm.onAction(ItemAction.Edit.SetChoices("people", listOf("x")))
        vm.onAction(ItemAction.Edit.SetText("nonexistent", "x"))
        assertTrue(fake.updates.isEmpty())
        vm.onAction(ItemAction.DismissWriteFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a failed write is reported with its kind and the item is read again`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        fake.updateAnswer = { failure(FailureKind.REJECTED) }
        vm.onAction(ItemAction.Edit.SetFlag("pinned", false))
        runCurrent()
        assertEquals(ItemWriteFailure("pinned", FailureKind.REJECTED), vm.state.value.writeFailure)
        assertFalse(vm.state.value.saving)
        assertEquals(2, fake.itemReads)
        fake.updateAnswer = { throw IllegalStateException("boom") }
        vm.onAction(ItemAction.Edit.SetFlag("pinned", true))
        runCurrent()
        assertEquals(ItemWriteFailure("pinned", null), vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a second write while one runs is ignored`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        val gate = CompletableDeferred<Unit>()
        fake.updateAnswer = {
            gate.await()
            RepositoryResult.Content(project)
        }
        vm.onAction(ItemAction.Edit.SetFlag("pinned", false))
        vm.onAction(ItemAction.Edit.SetFlag("pinned", true))
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, fake.updates.size)
        vm.close()
    }

    @Test fun `unlinking and taking over again go through the item link endpoints and read the item again`() =
        runTest(dispatcher) {
            arrange()
            val vm = open()
            vm.onAction(ItemAction.Edit.Unlink("status"))
            runCurrent()
            vm.onAction(ItemAction.Edit.Relink("status"))
            runCurrent()
            assertEquals(
                listOf(
                    "item:p1:company,people", "unlinkValue:p1:status", "item:p1:company,people",
                    "relinkValue:p1:status", "item:p1:company,people"
                ),
                fake.calls
            )
            fake.unitAnswer = { failure(FailureKind.REJECTED) }
            vm.onAction(ItemAction.Edit.Unlink("status"))
            runCurrent()
            assertEquals(ItemWriteFailure("status", FailureKind.REJECTED), vm.state.value.writeFailure)
            vm.close()
        }

    @Test fun `the picker lists the items of the target database and choosing one replaces a single target`() =
        runTest(dispatcher) {
            arrange()
            val vm = open()
            fake.queryAnswer = { _, _ ->
                page(
                    cz.semprec.app.domain.CollectionItem(
                        "person-2", PEOPLE_DB,
                        mapOf("name" to FieldValue.Text("Home")), emptyMap(), "c", "v"
                    )
                )
            }
            vm.onAction(ItemAction.Picker.Open("people"))
            assertEquals(PickerView("people", "People", true, null, emptyList()), vm.state.value.picker)
            runCurrent()
            assertEquals(listOf(TargetView("person-2", "people", "Home", null)), vm.state.value.picker?.candidates)
            assertFalse(vm.state.value.picker!!.loading)
            vm.onAction(ItemAction.Picker.Choose("person-2"))
            assertNull(vm.state.value.picker)
            runCurrent()
            assertEquals(
                listOf("item:p1:company,people", "set:p1:people:person-2", "item:p1:company,people"),
                fake.calls,
            )
            vm.close()
        }

    @Test fun `a relation that holds several targets is added to when it refuses a single replacement`() =
        runTest(dispatcher) {
            arrange()
            val vm = open()
            fake.setRelationAnswer = { failure(FailureKind.REJECTED) }
            vm.onAction(ItemAction.Picker.Open("company"))
            runCurrent()
            vm.onAction(ItemAction.Picker.Choose("c1"))
            runCurrent()
            assertTrue("link:p1:company:c1" in fake.calls)
            vm.onAction(ItemAction.Edit.RemoveTarget("company", "c1"))
            runCurrent()
            assertTrue("unlinkEdge:p1:company:c1" in fake.calls)
            vm.close()
        }

    @Test fun `a failing set that is not a refusal is not retried as a link`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        fake.setRelationAnswer = { failure(FailureKind.UNAVAILABLE) }
        vm.onAction(ItemAction.Picker.Open("people"))
        runCurrent()
        vm.onAction(ItemAction.Picker.Choose("a"))
        runCurrent()
        assertEquals(ItemWriteFailure("people", FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        assertTrue(fake.calls.none { it.startsWith("link:") })
        vm.close()
    }

    @Test fun `searching the picker queries the target database with the text and its filter`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Picker.Search("ignored while closed"))
        runCurrent()
        assertTrue(fake.queries.isEmpty())
        vm.onAction(ItemAction.Picker.Open("people"))
        runCurrent()
        vm.onAction(ItemAction.Picker.Search("wo"))
        runCurrent()
        assertEquals("wo", fake.queries.last().search)
        assertNull(fake.queries.first().search)
        vm.onAction(ItemAction.Picker.Close)
        assertNull(vm.state.value.picker)
        vm.onAction(ItemAction.Picker.Choose("x"))
        runCurrent()
        assertTrue(fake.calls.none { it.startsWith("set:") })
        vm.close()
    }

    @Test fun `a picker for something that is not a relation does not open and a failed search is shown`() =
        runTest(dispatcher) {
            arrange()
            val vm = open()
            vm.onAction(ItemAction.Picker.Open("status"))
            assertNull(vm.state.value.picker)
            fake.queryAnswer = { _, _ -> failure(FailureKind.UNAVAILABLE) }
            vm.onAction(ItemAction.Picker.Open("people"))
            runCurrent()
            assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.picker?.failure)
            vm.close()
        }

    @Test fun `the page is saved with the etag it was read with and a failed save is an error`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Page.Save("# New"))
        assertEquals(PageStatus.SAVING, vm.state.value.page.status)
        runCurrent()
        assertEquals(listOf(Triple("p1", "# New", "e0")), fake.pageReplacements)
        assertEquals(PageView(PageStatus.READY, "saved", null), vm.state.value.page)
        vm.onAction(ItemAction.Page.Save("# Again"))
        runCurrent()
        assertEquals("e1", fake.pageReplacements.last().third)
        fake.replacePageAnswer = { failure(FailureKind.REJECTED) }
        vm.onAction(ItemAction.Page.Save("# Stale"))
        runCurrent()
        assertEquals(PageView(PageStatus.ERROR, "saved", FailureKind.REJECTED), vm.state.value.page)
        vm.onAction(ItemAction.Page.Reload)
        runCurrent()
        assertEquals(PageStatus.READY, vm.state.value.page.status)
        vm.close()
    }

    @Test fun `a page that cannot be read is an error and cannot be saved over`() = runTest(dispatcher) {
        arrange()
        fake.pageAnswer = { failure(FailureKind.REJECTED) }
        val vm = open()
        assertEquals(PageView(PageStatus.ERROR, "", FailureKind.REJECTED), vm.state.value.page)
        vm.onAction(ItemAction.Page.Save("x"))
        runCurrent()
        assertTrue(fake.pageReplacements.isEmpty())
        fake.pageAnswer = { throw IllegalStateException("boom") }
        vm.onAction(ItemAction.Page.Reload)
        runCurrent()
        assertEquals(PageView(PageStatus.ERROR, "", null), vm.state.value.page)
        vm.close()
    }

    @Test fun `a file is downloaded for a preview and shown as Base64`() = runTest(dispatcher) {
        fake.itemAnswer = { RepositoryResult.Content(fileItem("f1", "Faktura.pdf")) }
        val vm = open(hint = "files", id = "f1")
        assertEquals(
            FieldContent.Blob("blob-f1", "Faktura.pdf", "application/pdf", 2048),
            vm.state.value.field("file").content,
        )
        assertFalse(vm.state.value.field("file").editable)
        vm.onAction(ItemAction.Preview.Load("file"))
        assertEquals(PreviewStatus.LOADING, vm.state.value.preview?.status)
        runCurrent()
        val preview = vm.state.value.preview!!
        assertEquals(PreviewStatus.READY, preview.status)
        assertEquals("AQID", preview.base64)
        assertEquals("image/png", preview.mimeType)
        vm.onAction(ItemAction.Preview.Close)
        assertNull(vm.state.value.preview)
        vm.close()
    }

    @Test fun `a failed download is shown and a property without a file has no preview`() = runTest(dispatcher) {
        fake.itemAnswer = { RepositoryResult.Content(fileItem("f1", "Faktura.pdf")) }
        fake.blobAnswer = { failure(FailureKind.NOT_FOUND) }
        val vm = open(hint = "files", id = "f1")
        vm.onAction(ItemAction.Preview.Load("name"))
        assertNull(vm.state.value.preview)
        vm.onAction(ItemAction.Preview.Load("file"))
        runCurrent()
        assertEquals(PreviewStatus.ERROR, vm.state.value.preview?.status)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.preview?.failure)
        vm.close()
    }

    @Test fun `closing the preview before the file arrives drops the answer`() = runTest(dispatcher) {
        fake.itemAnswer = { RepositoryResult.Content(fileItem("f1", "Faktura.pdf")) }
        val gate = CompletableDeferred<Unit>()
        fake.blobAnswer = {
            withContext(NonCancellable) {
                gate.await()
            }
            RepositoryResult.Content(cz.semprec.app.domain.BlobContent("a/b", byteArrayOf(1)))
        }
        val vm = open(hint = "files", id = "f1")
        vm.onAction(ItemAction.Preview.Load("file"))
        runCurrent()
        vm.onAction(ItemAction.Preview.Close)
        gate.complete(Unit)
        runCurrent()
        assertNull(vm.state.value.preview)
        vm.close()
    }

    @Test fun `deleting states what it reaches first and only a confirmation deletes`() = runTest(dispatcher) {
        arrange()
        fake.impactAnswer = {
            RepositoryResult.Content(
                DeleteImpact(
                    listOf(ImpactCollection("files", 3)), 2, 1, 4, 0,
                    0, 0
                )
            )
        }
        val vm = open()
        vm.onAction(ItemAction.Deletion.Confirm)
        runCurrent()
        assertTrue(fake.calls.none { it.startsWith("delete:") })
        vm.onAction(ItemAction.Deletion.Request)
        assertEquals(
            DeletionView(loading = true, failure = null, impact = null, deleting = false),
            vm.state.value.deletion
        )
        runCurrent()
        assertEquals(ImpactView(listOf(ImpactEntry("files", 3)), 2, 1, 4, 0, 0, 0), vm.state.value.deletion?.impact)
        vm.onAction(ItemAction.Deletion.Cancel)
        assertNull(vm.state.value.deletion)
        vm.onAction(ItemAction.Deletion.Request)
        runCurrent()
        vm.onAction(ItemAction.Deletion.Confirm)
        runCurrent()
        assertTrue("delete:p1" in fake.calls)
        assertTrue(vm.state.value.deleted)
        assertNull(vm.state.value.deletion)
        val received = mutableListOf<ItemEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(listOf<ItemEffect>(ItemEffect.Close), received)
        vm.close()
    }

    @Test fun `failures of the impact read and of the deletion are shown in the confirmation`() = runTest(dispatcher) {
        arrange()
        fake.impactAnswer = { failure(FailureKind.UNAVAILABLE) }
        val vm = open()
        vm.onAction(ItemAction.Deletion.Request)
        runCurrent()
        assertEquals(DeletionView(false, Failed(FailureKind.UNAVAILABLE), null, false), vm.state.value.deletion)
        fake.impactAnswer = { RepositoryResult.Content(DeleteImpact(emptyList(), 0, 0, 0, 0, 0, 0)) }
        vm.onAction(ItemAction.Deletion.Request)
        runCurrent()
        fake.unitAnswer = { failure(FailureKind.REJECTED) }
        vm.onAction(ItemAction.Deletion.Confirm)
        assertTrue(vm.state.value.deletion!!.deleting)
        runCurrent()
        assertEquals(
            DeletionView(false, Failed(FailureKind.REJECTED), vm.state.value.deletion?.impact, false),
            vm.state.value.deletion
        )
        assertFalse(vm.state.value.deleted)
        vm.close()
    }

    @Test fun `opening a related collection or a target emits one effect each`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        vm.onAction(ItemAction.Navigate.OpenRelated(FILES))
        vm.onAction(ItemAction.Navigate.OpenRelated("db-unknown"))
        vm.onAction(ItemAction.Navigate.OpenRelated("not-there"))
        vm.onAction(ItemAction.Navigate.OpenTarget("person-1", "people"))
        val received = mutableListOf<ItemEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(
            listOf(
                ItemEffect.OpenCollection(FILES, "files", """{"type":"relation_contains"}"""),
                ItemEffect.OpenItem("person-1", "people"),
            ),
            received,
        )
        vm.close()
    }

    @Test fun `a refresh keeps the item on screen and a newer read supersedes an older one`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        val slow = CompletableDeferred<Unit>()
        var reads = 0
        fake.itemAnswer = {
            reads += 1
            if (reads == 1) withContext(NonCancellable) { slow.await() }
            RepositoryResult.Content(projectItem("p1", if (reads == 1) "Old" else "Newer"))
        }
        vm.onAction(ItemAction.Refresh)
        assertEquals("Semprec iOS", vm.state.value.header?.title)
        runCurrent()
        vm.onAction(ItemAction.Refresh)
        runCurrent()
        assertEquals("Newer", vm.state.value.header?.title)
        slow.complete(Unit)
        runCurrent()
        assertEquals("Newer", vm.state.value.header?.title)
        vm.close()
    }

    @Test fun `a refresh that fails keeps the item`() = runTest(dispatcher) {
        arrange()
        val vm = open()
        fake.itemAnswer = { failure(FailureKind.UNAVAILABLE) }
        vm.onAction(ItemAction.Refresh)
        runCurrent()
        assertEquals(ItemPhase.CONTENT, vm.state.value.phase)
        assertEquals("Semprec iOS", vm.state.value.header?.title)
        vm.close()
    }

    @Test fun `closing ends the work and ignores later actions`() = runTest(dispatcher) {
        arrange()
        val gate = CompletableDeferred<Unit>()
        fake.itemAnswer = {
            gate.await()
            RepositoryResult.Content(project)
        }
        val vm = factory.itemViewModel("p1", "projects")
        runCurrent()
        vm.close()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(ItemState(), vm.state.value)
        vm.onAction(ItemAction.Retry)
        vm.onAction(ItemAction.Edit.Rename("x"))
        runCurrent()
        assertEquals(ItemState(), vm.state.value)
        assertEquals(1, fake.itemReads)
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        arrange()
        val store = ViewModelStore()
        val vm = store.provide { factory.itemViewModel("p1", "projects") }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(ItemAction.Refresh)
        runCurrent()
        assertEquals(1, fake.itemReads)
    }
}
