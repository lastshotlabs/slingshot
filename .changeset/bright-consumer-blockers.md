---
'@lastshotlabs/slingshot-assets': patch
'@lastshotlabs/slingshot-community': patch
'@lastshotlabs/slingshot-entity': patch
'@lastshotlabs/slingshot-postgres': patch
---

Fix four consumer-reported contract gaps: include owner and size data in asset lifecycle events, expose reply listing through the community public contract, decode Postgres numeric entity fields as JavaScript numbers, and preserve suspension timestamps in Postgres user reads.
