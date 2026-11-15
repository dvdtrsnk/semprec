package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ServerUrlTest {
    @Test fun `a bare host gets https`() =
        assertEquals("https://semprec.example", normalizeServerUrl("semprec.example"))

    @Test fun `whitespace and trailing slashes are dropped`() =
        assertEquals("https://semprec.example", normalizeServerUrl("  https://semprec.example//  "))

    @Test fun `a port is kept`() =
        assertEquals("https://semprec.example:8443", normalizeServerUrl("semprec.example:8443"))

    @Test fun `http is accepted only for a local address`() {
        assertEquals("http://localhost:3000", normalizeServerUrl("http://localhost:3000"))
        assertEquals("http://mini.local", normalizeServerUrl("http://mini.local"))
        assertEquals("http://mini.tail1234.ts.net", normalizeServerUrl("http://mini.tail1234.ts.net"))
        assertNull(normalizeServerUrl("http://semprec.example"))
    }

    @Test fun `blank and malformed input is refused`() {
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("   "))
        assertNull(normalizeServerUrl("ftp://semprec.example"))
        assertNull(normalizeServerUrl("semprec.example/path"))
        assertNull(normalizeServerUrl("semprec example"))
        assertNull(normalizeServerUrl("https://"))
    }
}
