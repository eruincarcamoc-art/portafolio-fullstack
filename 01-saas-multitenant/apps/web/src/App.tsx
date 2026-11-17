import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { atLeast, useAuth } from './auth';
import { api } from './api';
import { AuthPage } from './pages/AuthPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { MembersPage } from './pages/MembersPage';
import { BillingPage } from './pages/BillingPage';
import { AuditPage } from './pages/AuditPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';

function Shell() {
  const { user, workspaces, active, selectWorkspace, logout, reload } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function newWorkspace() {
    const name = window.prompt('Workspace name');
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const t = await api('POST', '/tenants', { name });
      await reload();
      selectWorkspace(t.id);
      navigate('/');
    } finally {
      setCreating(false);
    }
  }

  if (!active) return <p className="center">Loading workspace…</p>;
  const role = active.role;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">▲ Tenantly</div>
        <label className="field">
          <span>Workspace</span>
          <select value={active.id} onChange={(e) => selectWorkspace(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {w.plan}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost small" onClick={newWorkspace} disabled={creating}>
          + New workspace
        </button>
        <nav>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/members">Members</NavLink>
          {atLeast(role, 'admin') && <NavLink to="/billing">Billing</NavLink>}
          {atLeast(role, 'admin') && <NavLink to="/audit">Audit log</NavLink>}
        </nav>
        <div className="user">
          <div>
            <strong>{user?.name}</strong>
            <small>{user?.email}</small>
            <small className="badge">{role}</small>
          </div>
          <button className="ghost small" onClick={() => logout()}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/billing" element={atLeast(role, 'admin') ? <BillingPage /> : <Navigate to="/" />} />
          <Route path="/audit" element={atLeast(role, 'admin') ? <AuditPage /> : <Navigate to="/" />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const { loading, user } = useAuth();
  if (loading) return <p className="center">Loading…</p>;
  if (!user) {
    return (
      <Routes>
        <Route path="/accept-invite" element={<AuthPage inviteHint />} />
        <Route path="*" element={<AuthPage />} />
      </Routes>
    );
  }
  return <Shell />;
}
