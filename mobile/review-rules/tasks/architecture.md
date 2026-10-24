Check for architecture and ownership violations in the shared layer and the
Gradle build:

1. A `build.gradle.kts` dependency or a production import that makes a lower
   shared module depend on a higher one (core on any module, domain on data or
   presentation, presentation on data) or creates a cycle — `ARCH-DEPENDENCY`,
   high.
2. A platform-only API (`android.*`, `java.*`, `javax.*`, `platform.*`,
   `kotlinx.cinterop.*`, a JVM-only library) in a `src/commonMain` source set —
   `ARCH-DEPENDENCY`, high. Check an `androidx.*` artifact's real target support
   before reporting it: `androidx.lifecycle:lifecycle-viewmodel`, which
   `:shared:presentation` uses, is multiplatform.
3. A business decision — validation, ordering, eligibility, the meaning of a
   failure — added to presentation or data instead of a domain use case, so
   that another caller would have to make it again — `DOMAIN-SOURCE`, medium.
4. A package that does not match its directory, or one package declared in two
   modules — medium: each module owns its package (`cz.semprec.app.core`,
   `.domain`, `.data`, `.presentation`, `.sdk`), so a type is found by its
   package, and detekt does not check this (`InvalidPackageDeclaration` is off
   in `config/detekt/detekt.yml`).
5. New abstraction, config flag, or generalization not required by the
   linked issue's Task — medium severity (flag it as scope creep, not a
   style nitpick). A DI library, network client or persistence added to shared
   code is this finding unless the Task calls for it.
6. A module reaching into another module's internals instead of its declared
   public interface — high severity.
7. A genuinely new architectural pattern (not covered by an existing rule or an
   ADR under `docs/adr/`) introduced with no ADR added for it — medium
   severity, flag it as a missing decision record, not a style nitpick. See
   `docs/adr/README.md` for when an ADR is warranted and its format.

Not findings: a contract moved to an allowed lower module; a use case that only
forwards, whether present or absent.
