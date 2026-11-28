package cz.alldots.app.presentation

import cz.alldots.app.domain.InboxAttachment
import cz.alldots.app.domain.InboxAttachmentFiles
import cz.alldots.app.domain.InboxAttachmentLocation
import cz.alldots.app.domain.RepositoryResult

/** The device's attachment files: [answer] decides each call, which [calls] records with the file name asked for. */
internal class FakeAttachmentFiles : InboxAttachmentFiles {
    val calls = mutableListOf<Pair<InboxAttachmentLocation, String>>()
    var answer: suspend (InboxAttachmentLocation, String) -> RepositoryResult<String> =
        { _, name -> RepositoryResult.Content("/cache/$name") }

    override suspend fun file(location: InboxAttachmentLocation, fileName: String): RepositoryResult<String> {
        calls += location to fileName
        return answer(location, fileName)
    }
}

internal fun serverAttachment(id: String, name: String? = "scan.pdf", mimeType: String = "application/pdf") =
    InboxAttachment(id, name, mimeType, "files", InboxAttachmentLocation.Blob("blob-$id"))
