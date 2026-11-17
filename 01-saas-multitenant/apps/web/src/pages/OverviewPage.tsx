import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export const limitText = (n: number | null) => (n === null ? '∞' : String(n));

export function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 8 : Math.min(100, (used / limit) * 100);
  return (
    <div className="usage">
      <div className="usage-head">
        <span>{label}</span>
        <span>{used} / {limitText(limit)}</span>
      </div>
      <div className="bar"><div className={pct >= 100 ? 'fill full' : 'fill'} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function OverviewPage() {
  const { active } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['overview', active?.id], queryFn: () => api('GET', '/t') });
  if (isLoading || !data) return <p>Loading…</p>;
  const { tenant, usage, limits } = data;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{tenant.name}</h1>
          <p className="muted">Workspace overview</p>
        </div>
        <span className={`plan plan-${tenant.plan}`}>{tenant.plan}</span>
      </header>
      <section className="card">
        <h2>Plan usage</h2>
        <UsageBar label="Active projects" used={usage.projects} limit={limits.projects} />
        <UsageBar label="Seats (members + pending invites)" used={usage.members + usage.pendingInvitations} limit={limits.members} />
        {tenant.plan === 'free' && <p className="muted">Need more room? <Link to="/billing">Upgrade your plan</Link>.</p>}
      </section>
      <section className="card">
        <h2>How isolation works here</h2>
        <p className="muted">
          Every request carries <code>X-Tenant-Id</code>. The API opens a transaction as a restricted database role and sets
          <code> app.tenant_id</code>; PostgreSQL Row-Level Security then hides every other tenant's rows, even if a query forgets its filter.
        </p>
      </section>
    </>
  );
}
