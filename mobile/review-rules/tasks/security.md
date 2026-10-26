Check for security vulnerabilities:

1. Hardcoded credentials, API keys, or tokens anywhere in the diff —
   critical.
2. Signing material or a secret committed (a keystore, `.p12`, `.p8`,
   provisioning profile, private key, a `local.properties` or properties file
   carrying credentials) — critical; an entry that keeps such files out of the
   repository removed from `.gitignore` — high.
3. A change to the Gradle wrapper — `gradle/wrapper/gradle-wrapper.properties`,
   `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.jar.sha256`,
   `gradlew`, `gradlew.bat` — that drops `distributionSha256Sum`, points
   `distributionUrl` anywhere but `https://services.gradle.org/distributions/`,
   or records a checksum that is not the one Gradle publishes for that version
   — critical: the wrapper downloads and runs that code on every developer
   machine and agent host.
4. A new dependency or plugin repository in `settings.gradle.kts` or
   `build-logic/settings.gradle.kts`, a repository over plain HTTP, or a
   dependency fetched from a URL instead of a declared repository — high.
5. A secret, token, credential or user content reaching a log call or
   `println` in shared code — high.
6. A network call in the shared data layer that disables certificate
   validation or sends data over plain HTTP — critical.
7. A script under `scripts/` that runs a command built from an environment
   variable, argument or file content without quoting it, or that deletes or
   writes outside the directories it owns — high: `scripts/kmp-framework` runs
   inside every Xcode build of the app.
