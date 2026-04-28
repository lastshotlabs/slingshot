# Organizations Example

Source-backed example for `slingshot-organizations` on top of `slingshot-auth`.

## What it shows

- `createOrganizationsPlugin()` wired with `createAuthPlugin()` (orgs depends on auth)
- custom membership roles via `knownRoles` and `defaultMemberRole`
- reserved-slug enforcement and the typed `SlugConflictError` (HTTP 409)
- matching manifest and code-first setup

## Files

- `src/index.ts` - code-first app bootstrap
- `app.manifest.json` - manifest-first equivalent

## Run

From the repo root:

```bash
JWT_SECRET=dev-secret-change-me-dev-secret-change-me bun examples/organizations/src/index.ts
```

## Mounted routes

The organizations plugin mounts the standard entity surface:

| Method   | Path                              | What                           |
| -------- | --------------------------------- | ------------------------------ |
| `POST`   | `/orgs`                           | Create an organization         |
| `GET`    | `/orgs`                           | List organizations             |
| `GET`    | `/orgs/mine`                      | List orgs the actor belongs to |
| `POST`   | `/orgs/:orgId/invitations`        | Invite a user                  |
| `POST`   | `/orgs/:orgId/invitations/lookup` | Look up an invite by token     |
| `POST`   | `/orgs/:orgId/invitations/redeem` | Accept an invite               |
| `DELETE` | `/orgs/:orgId/invitations/:id`    | Revoke an invite               |
| `GET`    | `/orgs/:orgId/members`            | List members                   |
| `POST`   | `/orgs/:orgId/members`            | Add a member directly          |

## Walkthrough

```bash
# 1. Register two users (auth plugin)
TOKEN_OWNER=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"hunter2hunter2"}' | jq -r .token)

TOKEN_MEMBER=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"hunter2hunter2"}' | jq -r .token)

# 2. Create an org
curl -X POST http://localhost:3000/orgs \
  -H "authorization: Bearer $TOKEN_OWNER" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","slug":"acme"}'

# 3. Reserved slug — returns HTTP 409 with code "SLUG_CONFLICT"
curl -X POST http://localhost:3000/orgs \
  -H "authorization: Bearer $TOKEN_OWNER" \
  -H 'content-type: application/json' \
  -d '{"name":"Admin","slug":"admin"}'

# 4. Invite the second user
curl -X POST http://localhost:3000/orgs/<orgId>/invitations \
  -H "authorization: Bearer $TOKEN_OWNER" \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","role":"maintainer"}'

# 5. Accept the invite (token returned from step 4)
curl -X POST http://localhost:3000/orgs/<orgId>/invitations/redeem \
  -H "authorization: Bearer $TOKEN_MEMBER" \
  -H 'content-type: application/json' \
  -d '{"token":"<invite-token>"}'

# 6. List members
curl http://localhost:3000/orgs/<orgId>/members \
  -H "authorization: Bearer $TOKEN_OWNER"
```

## Custom roles

The `knownRoles` array is the entire vocabulary the plugin accepts on member,
invite, and group-membership records. Any role value outside that list is
rejected with HTTP 400. `defaultMemberRole` must be present in `knownRoles`.

## Slug validation

Slugs are normalized and validated against the framework defaults plus any
extra `reservedSlugs` you supply. Conflicts with the unique index surface as
the typed `SlugConflictError` (re-exported from
`@lastshotlabs/slingshot-organizations`), which serializes as:

```json
{ "error": "Slug 'acme' is already in use", "code": "SLUG_CONFLICT", "slug": "acme" }
```

Catch it programmatically with `instanceof SlugConflictError`.
