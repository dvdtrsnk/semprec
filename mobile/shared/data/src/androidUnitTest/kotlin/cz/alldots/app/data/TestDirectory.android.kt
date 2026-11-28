package cz.alldots.app.data

import java.nio.file.Files

internal actual fun newTestDirectory(): String = Files.createTempDirectory("alldots-cache-test").toString()
