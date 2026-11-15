-- Jaco Ebertsohn S&C app: database schema. Safe to run on every start.

CREATE SEQUENCE IF NOT EXISTS doc_rev;

-- Every record the app shows lives here, one row per document.
-- col: exercises | athletes | programs | feedback | settings | users
-- athlete_id: which athlete a row belongs to (used to limit what athletes can see)
-- rev: increases on every change, so browsers can fetch only what changed
-- deleted: rows are kept as markers when deleted, so other browsers learn about it
CREATE TABLE IF NOT EXISTS docs (
  col        text        NOT NULL,
  id         text        NOT NULL,
  data       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  athlete_id text,
  rev        bigint      NOT NULL,
  deleted    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS docs_rev_idx ON docs (rev);
CREATE UNIQUE INDEX IF NOT EXISTS docs_username_idx ON docs ((lower(data->>'username'))) WHERE col = 'users' AND NOT deleted;

-- Password hashes are kept apart from the user records and never sent to browsers.
CREATE TABLE IF NOT EXISTS credentials (
  user_id    text        PRIMARY KEY,
  pw_hash    text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Signed-in sessions. Only a hash of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text        PRIMARY KEY,
  user_id    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Photos uploaded in the app (the original exercise photos ship as files in /public/img).
CREATE TABLE IF NOT EXISTS blobs (
  id         text        PRIMARY KEY,
  mime       text        NOT NULL,
  bytes      bytea       NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Merge b into a, recursing into nested objects (used for partial updates).
CREATE OR REPLACE FUNCTION jsonb_deep_merge(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r jsonb := coalesce(a, '{}'::jsonb);
  k text;
  v jsonb;
BEGIN
  IF b IS NULL THEN RETURN a; END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RETURN b; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(b) LOOP
    IF jsonb_typeof(r -> k) = 'object' AND jsonb_typeof(v) = 'object' THEN
      r := jsonb_set(r, ARRAY[k], jsonb_deep_merge(r -> k, v));
    ELSE
      r := jsonb_set(r, ARRAY[k], v);
    END IF;
  END LOOP;
  RETURN r;
END $$;
