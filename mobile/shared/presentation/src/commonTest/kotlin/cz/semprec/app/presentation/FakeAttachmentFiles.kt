package cz.semprec.app.presentation

import cz.semprec.app.domain.InboxAttachment
import cz.semprec.app.domain.InboxAttachmentFiles
import cz.semprec.app.domain.InboxAttachmentLocation
import cz.semprec.app.domain.RepositoryResult

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
