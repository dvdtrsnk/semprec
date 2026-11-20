# Decision: carry production data with the develop seed's definitions

- Question: The cutover dry run (sp-cb9c39d0-a4a6-45c2-9ba8-39b72f56e0bf) found that carried v0.1.x data lacks 11 system properties the develop seed defines. Option 1 an additive reconcile issue, option 2 accept the gap and cut over without the internet-accounts features, option 3 start from an empty develop database.
- Options considered: as above.
- Decision: option 1, a new implementation issue. The owner decided on 2026-11-20 to move production to develop as part of the internet-accounts epic, which only makes sense with its features working on production data; option 3 loses the owner's data and option 2 defeats the epic. The cutover itself and its go/no-go remain the owner's.
- Spec change: new issue sp-61e09e8c-f4bf-418e-bb1c-0e9df00c81bd under epic sp-85e6cbc4-7de7-4385-81a9-a493c421b817.
- Actor: claude-delegated-by-david
- Model: claude-opus-5-5
- Date: 2026-11-20
