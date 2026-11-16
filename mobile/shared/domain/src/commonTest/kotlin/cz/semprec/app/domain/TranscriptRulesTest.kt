package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private val SEGMENTS = listOf(
    TranscriptSegment(0, "S1", "David", "Budget first.", 10.0, 20.0),
    TranscriptSegment(1, "S2", "Petr", "The BUDGET is fine.", 21.0, 30.0),
    TranscriptSegment(2, "S3", "Speaker 3", "Logos by Friday.", 31.0, 40.0),
)

class TranscriptRulesTest {
    @Test fun `a blank query keeps every segment`() {
        assertEquals(SEGMENTS, SEGMENTS.matching(""))
        assertEquals(SEGMENTS, SEGMENTS.matching("   "))
    }

    @Test fun `a query matches the text without regard to case`() {
        assertEquals(listOf(0, 1), SEGMENTS.matching("budget").map { it.index })
        assertEquals(listOf(2), SEGMENTS.matching(" FRIDAY ").map { it.index })
    }

    @Test fun `a query matches the name of the speaker too`() {
        assertEquals(listOf(1), SEGMENTS.matching("petr").map { it.index })
        assertEquals(listOf(2), SEGMENTS.matching("speaker 3").map { it.index })
    }

    @Test fun `a query nothing contains matches no segment`() {
        assertEquals(emptyList(), SEGMENTS.matching("zzz"))
    }

    @Test fun `the active segment is the last one that began at or before the position`() {
        assertNull(SEGMENTS.activeAt(5.0))
        assertEquals(0, SEGMENTS.activeAt(10.0))
        assertEquals(0, SEGMENTS.activeAt(20.5))
        assertEquals(1, SEGMENTS.activeAt(21.0))
        assertEquals(2, SEGMENTS.activeAt(9999.0))
        assertNull(emptyList<TranscriptSegment>().activeAt(5.0))
    }
}
