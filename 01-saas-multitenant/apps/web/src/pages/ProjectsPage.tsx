import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { atLeast, useAuth } from '../auth';

interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  created_at: string;
}

export function ProjectsPage() {
  const { active } = useAuth();
  const qc = useQueryClient();
  const role = active?.role;
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [form, setForm] = useState({ name: '', description: '' });
  const [error, setError] = useState('');

  const key = ['projects', active?.id, status];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: Project[]; total: number }>('GET', `/t/projects?status=${status}`),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projects', active?.id] });
    qc.invalidateQueries({ queryKey: ['overview', active?.id] });
  };
  const onError = (e: Error) => setError(e.message);

  const create = useMutation({
    mutationFn: () => api('POST', '/t/projects', form),
    onSuccess: () => {
      setForm({ name: '', description: '' });
      setError('');
      invalidate();
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; status: string }) => api('PATCH', `/t/projects/${v.id}`, { status: v.status }),
    onSuccess: () => { setError(''); invalidate(); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/t/projects/${id}`),
    onSuccess: invalidate,
    onError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <header className="page-head">
        <div><h1>Projects</h1><p className="muted">{data?.total ?? 0} {status}</p></div>
        <div className="tabs">
          <button className={status === 'active' ? 'tab on' : 'tab'} onClick={() => setStatus('active')}>Active</button>
          <button className={status === 'archived' ? 'tab on' : 'tab'} onClick={() => setStatus('archived')}>Archived</button>
        </div>
      </header>

      {atLeast(role, 'member') && (
        <form className="card row" onSubmit={submit}>
          <input required placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <button className="primary" disabled={create.isPending}>Add project</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      {isLoading ? <p>Loading…</p> : (
        <div className="list">
          {data?.items.length === 0 && <p className="muted card">Nothing here yet.</p>}
          {data?.items.map((p) => (
            <div key={p.id} className="card item">
              <div>
                <strong>{p.name}</strong>
                {p.description && <p className="muted">{p.description}</p>}
                <small className="muted">Created {new Date(p.created_at).toLocaleDateString()}</small>
              </div>
              <div className="actions">
                {atLeast(role, 'member') && (
                  <button className="ghost small" onClick={() => patch.mutate({ id: p.id, status: p.status === 'active' ? 'archived' : 'active' })}>
                    {p.status === 'active' ? 'Archive' : 'Restore'}
                  </button>
                )}
                {atLeast(role, 'admin') && (
                  <button className="danger small" onClick={() => window.confirm(`Delete "${p.name}"?`) && remove.mutate(p.id)}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
