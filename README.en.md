# Jev Situation Puzzles

An AI-hosted situation puzzle (turtle soup) game. Players ask questions about a
mystery story; the AI host "Jev" answers only **Yes / No / Irrelevant / Uncertain**.
Everyone shares the same reasoning trail and works toward the truth together.

- **Solo mode**: no sign-in required, free forever, unlimited; conversations and
  progress stay in your own browser
- **Multiplayer rooms**: private rooms for up to 8 friends; the server stores and
  syncs every round in real time
- **Sponsorship**: unsponsored accounts can create 10 multiplayer rooms in total;
  ¥6/month or ¥20 lifetime for unlimited rooms while active; joining a friend's
  room is always free

> Payments: the billing entry stays closed until the WeChat Pay merchant account
> is approved; the order and entitlement system is ready.

## Quick start (local development)

Prerequisites: Node.js 22+, pnpm 10, Docker (local database), a real SMTP
mailbox service (for sign-in codes).

```bash
pnpm install
cp .env.example .env.local        # fill in database and secrets (see comments)
docker run -d --name jev-pg -e POSTGRES_USER=jev -e POSTGRES_PASSWORD=jev \
  -e POSTGRES_DB=jev -p 5432:5432 postgres:17

pnpm db:migrate                   # append-only migrations, safe to re-run
pnpm db:seed                      # import 30 classic puzzles (dev only)

pnpm dev:api & pnpm dev:jobs & pnpm dev:web
```

Open http://localhost:5173 . The admin UI runs at http://localhost:5174/admin .

## Server deployment (one command)

```bash
cp .env.example .env   # domain, database password, SMTP, Jev key, etc.
docker compose up -d --build
```

This builds and starts everything: Caddy (automatic HTTPS) + player/admin static
sites + API + job worker + PostgreSQL. Database migrations run automatically when
the API container starts. For demo content run
`docker compose --profile seed run --rm seed` (production content requires a
rights review).

## License

[GPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
Puzzle content licensing is tracked separately in `data/library-sources.md`.
