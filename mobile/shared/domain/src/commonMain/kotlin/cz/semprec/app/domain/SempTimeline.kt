package cz.semprec.app.domain

/**
 * Which messages of a thread a person sees. A regenerated answer stays stored, readable only to the server, and a
 * retried reply has one message per attempt; the screen shows the newest attempt of each reply, in the order the
 * messages were made.
 */
object SempTimeline {

    fun visible(messages: List<SempMessage>): List<SempMessage> {
        val newest = messages.asSequence()
            .filter { it.role == SempRole.ASSISTANT && it.replyToMessageId != null }
            .groupBy { it.replyToMessageId }
            .mapValues { entry -> entry.value.maxOf { it.attempt } }
        return messages
            .filter { message ->
                when (message.role) {
                    SempRole.ASSISTANT ->
                        !message.replaced && message.attempt >= (newest[message.replyToMessageId] ?: 0)
                    SempRole.USER, SempRole.SYSTEM -> true
                }
            }
            .sortedWith(compareBy<SempMessage> { it.createdAt }.thenBy { it.id })
    }

    /** `true` while a visible reply is still being made, so the chat has to ask again. */
    fun awaitsReply(visible: List<SempMessage>): Boolean = visible.any {
        it.role == SempRole.ASSISTANT &&
            (it.status == SempMessageStatus.QUEUED || it.status == SempMessageStatus.RUNNING)
    }
}
