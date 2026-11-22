package cz.semprec.app.data

import java.nio.file.Files

internal actual fun newTestDirectory(): String = Files.createTempDirectory("semprec-cache-test").toString()
