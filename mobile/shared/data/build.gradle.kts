plugins { id("semprec.kmp") }
kotlin {
    sourceSets {
        commonMain.dependencies { implementation(project(":shared:domain")) }
        commonTest.dependencies { implementation(libs.coroutines.test) }
    }
}
