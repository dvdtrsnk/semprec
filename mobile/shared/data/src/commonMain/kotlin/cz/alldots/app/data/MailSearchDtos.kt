package cz.alldots.app.data

import cz.alldots.app.domain.MailRemoteSearch
import cz.alldots.app.domain.MailSearchResult
import kotlinx.serialization.Serializable

// The wire shape of `GET /api/mail/search`: the thread rows of the list, and what the provider search of each mailbox
// added. Unknown fields are ignored, among them `localCount` and the reason a mailbox's provider search failed.

@Serializable
internal data class MailSearchFailureDto(val mailboxId: String)

@Serializable
internal data class MailRemoteSearchDto(
    val searched: List<String> = emptyList(),
    val failed: List<MailSearchFailureDto> = emptyList(),
    val unindexed: Int = 0,
)

@Serializable
internal data class MailSearchDto(
    val threads: List<MailThreadDto> = emptyList(),
    val remote: MailRemoteSearchDto = MailRemoteSearchDto(),
)

internal fun MailSearchDto.toDomain() = MailSearchResult(
    threads = threads.map { it.toDomain() },
    remote = MailRemoteSearch(
        searched = remote.searched,
        failed = remote.failed.map { it.mailboxId },
        unindexed = remote.unindexed,
    ),
)
