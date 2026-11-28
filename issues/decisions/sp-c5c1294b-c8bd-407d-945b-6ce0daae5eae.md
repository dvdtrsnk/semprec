# Decision: recording the opening without a connection in the offline set's decision

- Question: The decision of the offline set ([[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]], added by sp-0412eb00-5180-4208-bb49-0e4c38ce9600 on the same unmerged branch) names opening the app offline as a later decision, and this issue delivers it: a restore that cannot reach the server opens the app with the person kept for the session. Where is that recorded, given that later code (the session gate, the status of the offline state) has to follow it?
- Options considered: (a) a new ADR for the kept person alone; (b) the offline set's decision, not merged yet, states it where it named it as later.
- Decision: (b). The kept person lives in the offline store that decision introduced, and the decision has not been accepted on `develop` yet, so no accepted record changes.
- Spec change (Touches): added "- docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md (opening without a connection)".
- Actor: claude-delegated-by-david
- Model: claude-opus-5-5
- Date: 2026-11-23
