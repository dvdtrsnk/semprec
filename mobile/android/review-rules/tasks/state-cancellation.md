Check state ownership, lifecycle-aware collection and cancellation in the
Android code. Rule IDs: `ASYNC-CANCELLATION`, `STATE-LIFETIME`.

1. `CancellationException` swallowed or mapped to an error — `catch
   (Exception)`, `catch (Throwable)` or `runCatching` around a suspend call
   without rethrowing it — `ASYNC-CANCELLATION`, high.
2. Screen-owned work in `GlobalScope`, in an application-wide scope, or holding
   an `Activity` or a `Context` beyond its lifecycle — `ASYNC-CANCELLATION`,
   high.
3. Superseded work not cancelled, so a stale result overwrites newer state —
   `ASYNC-CANCELLATION`, high when the changed code can reach it, otherwise
   low.
4. Screen state collected without lifecycle awareness (`collectAsState`, or a
   `LaunchedEffect` collecting a flow without `repeatOnLifecycle`) —
   `STATE-LIFETIME`, medium.
5. A `MutableStateFlow` or `MutableSharedFlow` exposed from a native
   `ViewModel` such as `SceneNavigation`, or a read-modify-write of its state
   that a concurrent caller can interleave and so lose an update —
   `STATE-LIFETIME`, medium.
6. A screen or session object with state registered as a Koin `single`, so two
   screens share it — `STATE-LIFETIME`, medium; high with a demonstrated leak
   from one screen into another.
7. Saved state that does not survive process death where the change relies on
   it — a value kept in `remember` instead of `rememberSaveable` or
   `SavedStateHandle` — `STATE-LIFETIME`, medium.

Name the owner, the lifecycle transition (stop, recreation, process death,
supersede) and the failure. Not findings: `viewModelScope.launch` with an error
boundary; a stateless service registered as `single`; `HomeSDK` as a `single`;
a Compose state holder such as `AppSceneState` whose properties are backed by
`MutableState`.
