import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { UsageBar } from './OverviewPage';

interface Billing {
  provider: 'stripe' | 'fake';
  plan: 'free' | 'pro' | 'business';
  status: string;
  currentPeriodEnd: string | null;
  hasCustomer: boolean;
  canManage: boolean;
  usage: { projects: number; members: number; pendingInvitations: number };
  limits: { projects: number | null; members: number | null };
  catalog: { id: string; label: string; priceUsd: number }[];
}

export function BillingPage() {
  const { active, reload } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState('');
  const fakePlan = params.get('fake_checkout') as 'pro' | 'business' | null;

  const { data } = useQuery({ queryKey: ['billing', active?.id], queryFn: () => api<Billing>('GET', '/t/billing') });
  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ['billing', active?.id] });
    await qc.invalidateQueries({ queryKey: ['overview', active?.id] });
    await reload();
  };
  const onError = (e: Error) => setError(e.message);

  const checkout = useMutation({
    mutationFn: (plan: string) => api<{ url: string }>('POST', '/t/billing/checkout', { plan }),
    onSuccess: (r) => { window.location.href = r.url; },
    onError,
  });
  const portal = useMutation({
    mutationFn: () => api<{ url: string }>('POST', '/t/billing/portal'),
    onSuccess: (r) => { window.location.href = r.url; },
    onError,
  });
  const simulate = useMutation({
    mutationFn: (action: string) => api('POST', '/t/billing/simulate', { action }),
    onSuccess: async () => { setParams({}); setError(''); await refreshAll(); },
    onError,
  });

  if (!data) return <p>Loading…</p>;
  return (
    <>
      <header className="page-head">
        <div><h1>Billing</h1><p className="muted">Current plan: <strong>{data.plan}</strong> · status: {data.status}</p></div>
        {data.currentPeriodEnd && <span className="muted">Renews {new Date(data.currentPeriodEnd).toLocaleDateString()}</span>}
      </header>
      {params.get('status') === 'success' && <p className="notice">Payment received. Your plan updates as soon as Stripe confirms via webhook.</p>}
      {error && <p className="error">{error}</p>}

      {data.provider === 'fake' && fakePlan && (
        <div className="card fake">
          <h2>Simulated checkout ({fakePlan})</h2>
          <p className="muted">Stripe isn't configured, so no real payment happens. Confirming fires the same <code>checkout.session.completed</code> event the real webhook would.</p>
          <button className="primary" onClick={() => simulate.mutate(fakePlan)}>Confirm payment</button>{' '}
          <button className="ghost" onClick={() => setParams({})}>Cancel</button>
        </div>
      )}

      <section className="card">
        <h2>Usage</h2>
        <UsageBar label="Active projects" used={data.usage.projects} limit={data.limits.projects} />
        <UsageBar label="Seats" used={data.usage.members + data.usage.pendingInvitations} limit={data.limits.members} />
      </section>

      <div className="plans">
        {data.catalog.map((p) => (
          <div key={p.id} className={`card plan-card ${p.id === data.plan ? 'current' : ''}`}>
            <h2>{p.label}</h2>
            <p className="price">${p.priceUsd}<small>/mo</small></p>
            {p.id === data.plan ? <span className="badge">Current plan</span> : p.id === 'free' ? null : (
              <button className="primary" disabled={!data.canManage || checkout.isPending} onClick={() => checkout.mutate(p.id)}>
                {data.plan === 'free' ? 'Upgrade' : 'Switch'} to {p.label}
              </button>
            )}
          </div>
        ))}
      </div>
      {!data.canManage && <p className="muted">Only the workspace owner can change the plan.</p>}

      {data.canManage && data.hasCustomer && data.provider === 'stripe' && (
        <button className="ghost" onClick={() => portal.mutate()}>Manage payment method & invoices</button>
      )}
      {data.canManage && data.provider === 'fake' && data.plan !== 'free' && (
        <section className="card">
          <h2>Dev tools (fake provider)</h2>
          <button className="ghost small" onClick={() => simulate.mutate('payment_failed')}>Simulate failed payment</button>{' '}
          <button className="danger small" onClick={() => simulate.mutate('cancel')}>Simulate cancellation</button>
        </section>
      )}
    </>
  );
}
