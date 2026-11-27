package moe.quill.nanotes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerOriginTest {
    @Test
    fun normalizesTypedServerAddresses() {
        assertEquals("https://app.example.com", ServerOrigin.parse(" app.example.com/ ")?.value)
        assertEquals("https://app.example.com", ServerOrigin.parse("HTTPS://App.Example.com:443")?.value)
        assertEquals("http://10.0.0.5:8080", ServerOrigin.parse("http://10.0.0.5:8080")?.value)
    }

    @Test
    fun rejectsAddressesThatAreNotABareOrigin() {
        assertNull(ServerOrigin.parse(""))
        assertNull(ServerOrigin.parse("ftp://app.example.com"))
        assertNull(ServerOrigin.parse("https://app.example.com/path"))
        assertNull(ServerOrigin.parse("https://user@app.example.com"))
    }

    @Test
    fun keepsOnlyTheServerInsideTheApp() {
        val origin = ServerOrigin.parse("https://app.example.com")!!

        assertTrue(origin.opensInApp("https://app.example.com/#/items"))
        assertFalse(origin.opensInApp("http://app.example.com/"))
        assertFalse(origin.opensInApp("https://app.example.com.evil.test/"))
        assertFalse(origin.opensInApp("https://github.com/QuillDev"))
    }
}
