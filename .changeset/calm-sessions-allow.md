---
'@lastshotlabs/slingshot': patch
'@lastshotlabs/slingshot-auth': patch
---

Use one canonical session-binding fingerprint across authenticated requests and refresh rotation, honor every refresh mismatch policy without destructive rejection, and preserve application/readiness availability when the global rate-limit store is unavailable.
