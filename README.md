# Jaco Ebertsohn · Strength & Conditioning app

An exercise library, program builder, athlete session view and post-session feedback calendar for Jaco Ebertsohn's athletes.

## How it's built

- `public/`: the app the browser loads (`index.html` is built from `src/app.html`) and the exercise photos.
- `server/index.js`: a small Node server with no framework. It serves `public/`, handles sign-in and stores data in Postgres.
- `server/schema.sql`: the database tables. The server applies them on every start.
- `db/seed.json`: the first-run data (exercises, Erik's programs, practice details, two logins). It's loaded only when the database has no logins yet.

## Security model

- Passwords are hashed on the server with scrypt and never sent to browsers.
- Signing in sets an httpOnly, SameSite cookie. Sessions last 30 days and can be ended by logging out or changing the password.
- Every read and write is checked on the server:
  - Coaches can read and change everything.
  - Athletes can read the exercise library, the practice details and their own athlete record, programs, feedback and login. They can only add new feedback for themselves.
- Writes from other websites are refused through an Origin check plus JSON-only bodies.
- After repeated failed sign-ins, the server blocks further attempts for 15 minutes: after 10 failures for a username, or 30 from one network address.

## Hosting (proof of concept)

- Render web service `jaco-app` (free plan, Frankfurt), set up by `render.yaml`. The free plan sleeps after 15 minutes without visitors, so the first visit after that takes about a minute.
- Data lives in schema `jaco` inside the existing free Render Postgres database `fdonc-crm-db-7dpw`, apart from the CRM's tables. **That database expires on 13 December 2026** unless upgraded. Before a real pilot, create a paid database for this app and change `DATABASE_URL`. The app seeds itself on first start, or copy the `jaco` schema across with `pg_dump --schema=jaco`.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/jaco npm start
```

## Change the app

Edit `src/app.html`, then run `npm run build` and commit both `src/app.html` and `public/index.html`. A push to `main` deploys automatically on Render.

## Settings (environment variables)

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Render sets this from the database). |
| `DB_SCHEMA` | Optional. Keeps every table in this Postgres schema (e.g. `jaco`), so the app can share a database with another app. The server refuses to start if it can't use that schema. |
| `SEED_PASSWORD` | Password for the seeded logins on first run (default `admin`). Change both passwords in the app afterwards. |
| `LOG_REQUESTS` | Set to `1` to log API requests. |
