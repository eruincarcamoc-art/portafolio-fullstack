import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { atLeast, useAuth, type Role } from '../auth';

interface Member { id: string; email: string; name: string; role: Role }
interface Invitation { id: string; email: string; role: Role; expires_at: string }

export function MembersPage() {
  const { active, user } = useAuth();
  const qc = useQueryClient();
  const myRole = active?.role;
  const canManage = atLeast(myRole, 'admin');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [error, setError] = useState('');
  const [link, setLink] = useState('');

  const { data } = useQuery({
    queryKey: ['members', active?.id],
    queryFn: () => api<{ members: Member[]; invitations: Invitation[] }>('GET', '/t/members'),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members', active?.id] });
    qc.invalidateQueries({ queryKey: ['overview', active?.id] });
  };
  const onError = (e: Error) => setError(e.message);

  const invite = useMutation({
    mutationFn: () => api('POST', '/t/invitations', { email, role }),
    onSuccess: (r) => { setEmail(''); setError(''); setLink(r.acceptUrl); refresh(); },
    onError,
  });
  const changeRole = useMutation({
    mutationFn: (v: { id: string; role: Role }) => api('PATCH', `/t/members/${v.id}`, { role: v.role }),
    onSuccess: () => { setError(''); refresh(); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/t/members/${id}`),
    onSuccess: () => { setError(''); refresh(); },
    onError,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api('DELETE', `/t/invitations/${id}`), onSuccess: refresh, onError });

  const submit = (e: FormEvent) => { e.preventDefault(); invite.mutate(); };
  const editable = (m: Member) => canManage && (myRole === 'owner' || m.role !== 'owner');

  return (
    <>
      <header className="page-head"><div><h1>Members</h1><p className="muted">People with access to this workspace</p></div></header>

      {canManage && (
        <form className="card row" onSubmit={submit}>
          <input type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option>
          </select>
          <button className="primary" disabled={invite.isPending}>Invite</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {link && (
        <p className="notice">
          Invitation created. In production this link is emailed; copy it for testing:<br />
          <code className="wrap">{link}</code>
        </p>
      )}

      <div className="list">
        {data?.members.map((m) => (
          <div key={m.id} className="card item">
            <div><strong>{m.name}</strong>{m.id === user?.id && ' (you)'}<p className="muted">{m.email}</p></div>
            <div className="actions">
              {editable(m) ? (
                <select value={m.role} onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}>
                  {(myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer']).map((r) => <option key={r} value={r}>{r}</option>)}
                  {myRole !== 'owner' && m.role === 'owner' && <option value="owner">owner</option>}
                </select>
              ) : <span className="badge">{m.role}</span>}
              {(editable(m) || m.id === user?.id) && (
                <button className="danger small" onClick={() => window.confirm(m.id === user?.id ? 'Leave this workspace?' : `Remove ${m.name}?`) && remove.mutate(m.id)}>
                  {m.id === user?.id ? 'Leave' : 'Remove'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {(data?.invitations.length ?? 0) > 0 && (
        <>
          <h2>Pending invitations</h2>
          <div className="list">
            {data!.invitations.map((i) => (
              <div key={i.id} className="card item">
                <div><strong>{i.email}</strong><p className="muted">as {i.role} · expires {new Date(i.expires_at).toLocaleDateString()}</p></div>
                {canManage && <button className="ghost small" onClick={() => revoke.mutate(i.id)}>Revoke</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
