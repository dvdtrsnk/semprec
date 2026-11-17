Check cancellation, state ownership and the lifetime of coroutines and flows in
shared code. Rule IDs: `ASYNC-CANCELLATION`, `STATE-LIFETIME`.

1. `CancellationException` caught and swallowed, logged as an error, or mapped
   to a failure state — including `catch (Exception)` or `catch (Throwable)`
   without a preceding `catch (cancelled: CancellationException) { throw
   cancelled }`, and `runCatching` around a suspend call — `ASYNC-CANCELLATION`,
   high. Cancellation is never an error and never a state.
2. A newer load or `close()` that does not invalidate an older one — the
   previous job not cancelled, or a result applied without `ensureActive()`
   after the suspend call — so a stale result can overwrite newer state —
   `ASYNC-CANCELLATION`, high when the changed code can reach it, otherwise low.
3. A collector, flow or job not tied to its owner's scope, so it keeps running
   after the ViewModel is closed — `ASYNC-CANCELLATION`, high.
4. A `MutableStateFlow`, `MutableSharedFlow` or `Channel` exposed as public API,
   or screen state kept in an `object` or another process-wide holder so two
   screens share it — `STATE-LIFETIME`, medium; high with a demonstrated leak
   from one screen into another.
5. A dispatcher, clock or other source of time hard-wired where the changed
   behavior needs a deterministic test — `STATE-LIFETIME`, low.

Name the owner, the transition (close, retry, supersede) and the failure.
