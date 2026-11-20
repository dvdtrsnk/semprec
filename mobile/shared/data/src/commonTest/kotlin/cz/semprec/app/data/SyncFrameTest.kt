package cz.semprec.app.data

import cz.semprec.app.domain.SyncTopic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val DB = "0d6e3a2c-1111-4c8a-9b7e-000000000001"
private const val ITEM = "0d6e3a2c-1111-4c8a-9b7e-000000000002"

class SyncFrameTest {
    private val item = """{"type":"invalidate","scope":"item","databaseId":"$DB","itemId":"$ITEM","op":"update",""" +
        """"updatedAt":"2026-11-20T10:00:00.000Z"}"""

    @Test fun `the item and relation and notification frames are kept`() {
        val relation = """{"type":"invalidate","scope":"relation","databaseId":"$DB","itemId":"$ITEM",""" +
            """"propertyKey":null,"op":"put"}"""
        val keyedRelation = relation.replace("\"propertyKey\":null", "\"propertyKey\":\"attendees\"")
        val notification = """{"type":"notification","notification":{"id":"n1","userId":"u1",""" +
            """"kind":"calendar_invitation","title":"Invite"}}"""
        assertEquals(SyncFrame.DatabaseChanged(DB), parseSyncFrame(item))
        assertEquals(SyncFrame.DatabaseChanged(DB), parseSyncFrame(relation))
        assertEquals(SyncFrame.DatabaseChanged(DB), parseSyncFrame(keyedRelation))
        assertEquals(SyncFrame.Notified("calendar_invitation"), parseSyncFrame(notification))
    }

    @Test fun `frames outside the followed catalog or with a broken field are dropped`() {
        listOf(
            "not json",
            "[]",
            """{"type":"invalidate","scope":"schema","databaseId":"$DB"}""",
            """{"type":"invalidate","scope":"badgeCounts"}""",
            """{"type":"doc:ack","docId":"$DB","clientUpdateId":"x"}""",
            item.replace("\"op\":\"update\"", "\"op\":\"rename\""),
            item.replace("\"databaseId\":\"$DB\"", "\"databaseId\":7"),
            item.replace(",\"updatedAt\":\"2026-11-20T10:00:00.000Z\"", ""),
            """{"type":"invalidate","scope":"relation","databaseId":"$DB","itemId":"$ITEM",""" +
                """"propertyKey":3,"op":"put"}""",
            """{"type":"invalidate","scope":"relation","databaseId":"$DB","itemId":"$ITEM","op":"merge"}""",
            """{"type":"notification","notification":{"id":"n1","kind":"calendar_invitation"}}""",
            """{"type":"notification","notification":"calendar_invitation"}""",
        ).forEach { raw -> assertNull(parseSyncFrame(raw), raw) }
    }

    @Test fun `a frame raises the topics of its database or notification kind`() {
        val keys = mapOf(
            "c" to "calendars", "e" to "events", "t" to "tasks", "i" to "invitations",
            "m" to "mailboxes", "f" to "folders", "x" to "emails", "n" to "notes"
        )
        val calendar = setOf(SyncTopic.CALENDAR)
        val mail = setOf(SyncTopic.MAIL_ACCOUNTS)
        mapOf(
            SyncFrame.DatabaseChanged("c") to calendar,
            SyncFrame.DatabaseChanged("e") to calendar,
            SyncFrame.DatabaseChanged("t") to calendar,
            SyncFrame.DatabaseChanged("i") to setOf(SyncTopic.INVITATIONS),
            SyncFrame.DatabaseChanged("m") to mail,
            SyncFrame.DatabaseChanged("f") to mail,
            SyncFrame.DatabaseChanged("x") to mail,
            SyncFrame.DatabaseChanged("n") to emptySet(),
            SyncFrame.DatabaseChanged("unknown") to emptySet(),
            SyncFrame.Notified("calendar_invitation") to setOf(SyncTopic.INVITATIONS),
            SyncFrame.Notified("mail_sync_error") to mail,
            SyncFrame.Notified("mail_sync_stalled") to mail,
            SyncFrame.Notified("approval_pending") to emptySet(),
        ).forEach { (frame, topics) -> assertEquals(topics, frame.topics(keys), frame.toString()) }
    }

    @Test fun `without the schema a database change raises every topic`() {
        assertEquals(SyncTopic.entries.toSet(), SyncFrame.DatabaseChanged("e").topics(null))
        assertEquals(setOf(SyncTopic.INVITATIONS), SyncFrame.Notified("calendar_invitation").topics(null))
    }

    @Test fun `the reconnect delay grows from one second to a thirty second ceiling with jitter`() {
        assertEquals(listOf(1_000L, 1_000L, 1_000L, 1_000L), (0..3).map { nextReconnectDelayMillis(it) { 0.0 } })
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L),
            listOf(0, 1, 2, 3, 4, 5, 6, 40).map { nextReconnectDelayMillis(it) { 1.0 } },
        )
        assertEquals(2_500L, nextReconnectDelayMillis(2) { 0.5 })
    }

    @Test fun `the socket address follows the scheme of the server`() {
        assertEquals("wss://s.example/api/sync", socketUrl("https://s.example", "/api/sync"))
        assertEquals("ws://127.0.0.1:8080/api/sync", socketUrl("http://127.0.0.1:8080", "/api/sync"))
    }
}
