# 🏂 Livigno Expenses — Gruppenkasse 2026

Expense tracker for the Livigno snowboard trip (March 18-22, 2026).

## Features
- Mobile-first UI for quick expense logging on the slopes
- Automatic settlement calculation (who owes whom)
- REST API + webhook endpoint for n8n integration
- SQLite persistent storage
- Docker-ready for Coolify deployment

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000`

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/expenses` | List all expenses |
| POST | `/api/expenses` | Add expense `{person, what, amount, for_who}` |
| DELETE | `/api/expenses/:id` | Delete expense |
| GET | `/api/summary` | Get settlement calculation |
| GET | `/api/webhook/add` | Webhook: `?person=Kai&betrag=25&was=Bier` |

## Crew
- Kai, Patrick L., Patrick Lu., Flo
