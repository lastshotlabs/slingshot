---
'@lastshotlabs/slingshot': patch
'@lastshotlabs/slingshot-core': patch
---

Fix the WebSocket heartbeat closing sockets it has never pinged. The sweep seeded a pong
deadline when a socket OPENED and evaluated it before sending the ping that would refresh
it, so with the defaults (`intervalMs` 30000, `timeoutMs` 10000) every connection was closed
with `1001 Heartbeat timeout` roughly twice a minute. Heartbeat entries now track the ping
awaiting an answer, so a socket is only closed once a ping it was actually sent goes
unanswered — and `timeoutMs` may now be shorter than `intervalMs`, which makes the shipped
defaults a working configuration. A thrown `ping()` is also contained per socket instead of
ending that tick for every other connection.
