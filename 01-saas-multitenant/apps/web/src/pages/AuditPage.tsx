import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';

interface Entry {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
}
interface Page { items: Entry[]; nextBefore: number | null; retentionDays: number }

export function AuditPage() {
  const { active } = useAuth();
  const q = useInfiniteQuery({
    queryKey: ['audit', active?.id],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<Page>('GET', `/t/audit?limit=25${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const retention = q.data?.pages[0]?.retentionDays;

  return (
    <>
      <header className="page-head"><div><h1>Audit log</h1><p className="muted">Append-only. Retention on your plan: {retention ?? '…'} days</p></div></header>
      <div className="card table">
        {items.map((e) => (
          <div key={e.id} className="log">
            <code>{e.action}</code>
            <span>{e.actor_name ?? 'system'}</span>
            <small className="muted">{Object.keys(e.meta).length ? JSON.stringify(e.meta) : ''}</small>
            <small className="muted">{new Date(e.created_at).toLocaleString()}</small>
          </div>
        ))}
        {!items.length && !q.isLoading && <p className="muted">No activity yet.</p>}
      </div>
      {q.hasNextPage && <button className="ghost" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</button>}
    </>
  );
}
