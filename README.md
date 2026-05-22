# MyTracker

A minimalist calorie & body-weight tracker. Originally a static localStorage
app; now a Node.js site with user accounts, so each person's data syncs across
every device they log in from.

## Stack

- **Server:** Node.js + Express
- **Storage:** SQLite via the built-in `node:sqlite` module (no native build step)
- **Auth:** cookie-based sessions (`cookie-session`), passwords hashed with scrypt
- **Client:** the original vanilla-JS single-page app in `public/`

## Requirements

- Node.js **22.5+** (the built-in SQLite module; 23.4+ runs it without a flag)

## Run locally

```bash
npm install
npm start          # http://localhost:3000
# or: npm run dev  — restarts on file changes
```

The SQLite database is created automatically at `data/app.db` on first run.

## Environment variables

| Variable         | Purpose                                            | Default                         |
| ---------------- | -------------------------------------------------- | ------------------------------- |
| `PORT`           | Port to listen on                                  | `3000`                          |
| `SESSION_SECRET` | Secret used to sign session cookies                | a dev-only fallback             |
| `NODE_ENV`       | Set to `production` to require HTTPS-only cookies  | unset                           |

In production, always set a strong `SESSION_SECRET`:

```bash
SESSION_SECRET="$(openssl rand -hex 32)" NODE_ENV=production npm start
```

## Deployment

This is a Node server, so it **cannot run on GitHub Pages** (where the static
version was hosted). Deploy to a host that runs a Node process — e.g. Render,
Railway, Fly.io, or a VPS. Two things to keep in mind:

1. Set `SESSION_SECRET` and `NODE_ENV=production`.
2. The SQLite file lives in `data/` — put that directory on a **persistent
   disk/volume**, otherwise accounts are wiped on every redeploy.

## API

| Method | Route               | Auth | Description                          |
| ------ | ------------------- | ---- | ------------------------------------ |
| POST   | `/api/auth/signup`  | —    | Create an account, start a session   |
| POST   | `/api/auth/login`   | —    | Log in, start a session              |
| POST   | `/api/auth/logout`  | —    | End the session                      |
| GET    | `/api/auth/me`      | —    | Current user, or 401                 |
| GET    | `/api/state`        | ✓    | Fetch this user's tracker data       |
| PUT    | `/api/state`        | ✓    | Replace this user's tracker data     |
