plugins {
    id("alldots.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
}

android { buildFeatures.compose = true }

addComposePreviewTooling()
