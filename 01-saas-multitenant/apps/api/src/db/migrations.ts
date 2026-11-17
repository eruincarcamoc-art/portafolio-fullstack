export interface Migration {
  id: string;
  sql: string;
}

const POLICY = (t: string) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${t}
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
`;

export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenantly_app') THEN
    CREATE ROLE tenantly_app NOLOGIN;
  END IF;
END $$;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  slug                   text NOT NULL UNIQUE,
  plan                   text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','business')),
  subscription_status    text NOT NULL DEFAULT 'none',
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_tenant_idx ON projects(tenant_id, created_at DESC);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations(tenant_id);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_idx ON audit_log(tenant_id, id DESC);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotencia de webhooks: un evento de Stripe se procesa exactamente una vez.
CREATE TABLE stripe_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Row-Level Security: el aislamiento vive en la base de datos =====
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
${POLICY('memberships')}
${POLICY('projects')}
${POLICY('invitations')}
${POLICY('audit_log')}

-- Privilegios minimos del rol de aplicacion. audit_log es append-only (sin UPDATE/DELETE).
GRANT SELECT, UPDATE ON tenants TO tenantly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, projects, invitations TO tenantly_app;
GRANT SELECT, INSERT ON audit_log TO tenantly_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO tenantly_app;
GRANT SELECT (id, email, name) ON users TO tenantly_app;
`,
  },
];
