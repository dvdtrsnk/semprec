package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ServerUrlTest {
    @Test fun `a bare host gets https`() =
        assertEquals("https://alldots.example", normalizeServerUrl("alldots.example"))

    @Test fun `whitespace and trailing slashes are dropped`() =
        assertEquals("https://alldots.example", normalizeServerUrl("  https://alldots.example//  "))

    @Test fun `a port is kept`() =
        assertEquals("https://alldots.example:8443", normalizeServerUrl("alldots.example:8443"))

    @Test fun `http is accepted only for a local address`() {
        assertEquals("http://localhost:3000", normalizeServerUrl("http://localhost:3000"))
        assertEquals("http://mini.local", normalizeServerUrl("http://mini.local"))
        assertEquals("http://mini.tail1234.ts.net", normalizeServerUrl("http://mini.tail1234.ts.net"))
        assertNull(normalizeServerUrl("http://alldots.example"))
    }

    @Test fun `blank and malformed input is refused`() {
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("   "))
        assertNull(normalizeServerUrl("ftp://alldots.example"))
        assertNull(normalizeServerUrl("alldots.example/path"))
        assertNull(normalizeServerUrl("alldots example"))
        assertNull(normalizeServerUrl("https://"))
    }
}
