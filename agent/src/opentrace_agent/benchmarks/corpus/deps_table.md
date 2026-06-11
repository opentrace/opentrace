# Service dependency register (deps.xlsx, sheet 1)

| Service | Depends on | Tier | Last reviewed |
|---|---|---|---|
| Auth Service | Token Vault | 1 | 2026-04-02 |
| Auth Service | User Directory | 1 | 2026-04-02 |
| Notification Hub | Auth Service | 2 | 2026-03-18 |
| Notification Hub | Email Relay | 2 | 2026-03-18 |

Notes row: tier-1 services page on-call directly; tier assignments are
reviewed quarterly.
