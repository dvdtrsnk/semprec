package cz.alldots.app.domain

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

class InboxAttachmentTest {
    private data class Case(val name: String?, val mimeType: String?, val source: String?, val fileName: String)

    @Test fun `a file name is safe to write in one directory and ends in an extension of its media type`() {
        val cases = listOf(
            Case("Invoice 2026.pdf", "application/pdf", "files", "Invoice 2026.pdf"),
            Case("Invoice", "application/pdf", "files", "Invoice.pdf"),
            Case("IMG_1.JPEG", "image/jpeg", "camera", "IMG_1.JPEG"),
            Case("photo.heic", "image/jpeg", "photoLibrary", "photo.heic.jpg"),
            Case("v1.2 notes", "application/pdf; charset=binary", "files", "v1.2 notes.pdf"),
            Case(null, "application/pdf", "scan", "Scan.pdf"),
            Case(null, "image/jpeg", "camera", "Photo.jpg"),
            Case(null, "image/png", "photoLibrary", "Photo.png"),
            Case(null, "application/pdf", "share", "Attachment.pdf"),
            Case(null, "application/pdf", null, "Attachment.pdf"),
            Case(null, "application/x-unknown", "files", "Attachment"),
            Case(null, null, null, "Attachment"),
            Case("", "audio/mpeg", "files", "Attachment.mp3"),
            Case("../../etc/passwd", "text/plain", "files", "passwd.txt"),
            Case("..\\..\\boot.ini", null, "files", "boot.ini"),
            Case("..", "application/pdf", "files", "Attachment.pdf"),
            Case(" .hidden.pdf", "application/pdf", "files", "hidden.pdf"),
            Case("a/", "application/pdf", "files", "Attachment.pdf"),
            Case("re:port*?<>|\".docx", DOCX, "files", "report.docx"),
            Case("tab\tnew\nline\u0000.pdf", "application/pdf", "files", "tabnewline.pdf"),
            Case("evil\u202Efdp.exe", "application/pdf", "files", "evilfdp.exe.pdf"),
        )
        for (case in cases) {
            assertEquals(case.fileName, attachmentFileName(case.name, case.mimeType, case.source), "$case")
        }
    }

    @Test fun `a long name is cut and keeps its extension`() {
        val name = attachmentFileName("x".repeat(300) + ".pdf", "application/pdf", "files")
        assertEquals(100, name.length)
        assertTrue(name.endsWith("x.pdf"))
        assertEquals(100, attachmentFileName("y".repeat(300), null, "files").length)
    }

    @Test fun `opening an attachment asks for its location under its file name`() = runTest {
        val asked = mutableListOf<Pair<InboxAttachmentLocation, String>>()
        val files = object : InboxAttachmentFiles {
            override suspend fun file(location: InboxAttachmentLocation, fileName: String): RepositoryResult<String> {
                asked += location to fileName
                return RepositoryResult.Content("/cache/$fileName")
            }
        }
        val waiting = InboxAttachment("c1", null, "image/jpeg", "camera", InboxAttachmentLocation.WaitingCapture("c1"))

        assertEquals(RepositoryResult.Content("/cache/Photo.jpg"), OpenInboxAttachment(files)(waiting))
        assertEquals(listOf<Pair<InboxAttachmentLocation, String>>(waiting.location to "Photo.jpg"), asked)
    }
}
