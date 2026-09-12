# shared/

Code that the **server and the browser must agree about**, imported directly by both.

It is here because agreeing by copy does not work. Captions were the case that proved it: the box
counted one way, the server counted another, and the difference was silent truncation of somebody's
sentence. A rule enforced in two places is a rule that will eventually be enforced two ways.

## How it is wired

No aliases, no build step, no package publishing — the container mirrors the repo layout, so **one
relative path resolves the same in both**:

| | repo | image |
|---|---|---|
| app | `app/src/server/…` | `/app/src/server/…` |
| web | `web/src/…` | `/app/src/…` |
| shared | `shared/…` | `/shared/…` |

So `../../../shared/caption` means the same thing whether you are running `npm run check` on a
laptop or inside the built image. Both images are built from the **repo root** as their Docker
context (see `.github/workflows/release.yml` and `app/docker-compose.dev.yml`) — that is what makes
`shared/` visible to each build at all.

## Rules

- Keep it dependency-free and runtime-agnostic: no `node:` imports, no DOM, no SvelteKit. It has to
  run in both places unchanged.
- Anything here is load-bearing for both halves of the product. Changing it changes what the server
  accepts *and* what the box allows, in one move — which is the entire point.
