import { useState } from 'react';
import { getIdentity, recentBoards, setName } from './identity';
import { navigate } from './router';

export function Home() {
  const [name, setN] = useState(getIdentity().name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recent = recentBoards();

  async function create() {
    setBusy(true);
    setError('');
    try {
      setName(name);
      const res = await fetch('/api/boards', { method: 'POST' });
      if (!res.ok) throw new Error('Could not create the board');
      const { id } = await res.json();
      navigate(`/b/${id}?new=1`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <h1>▦ Collab Board</h1>
      <p className="muted lead">
        A real-time kanban board built on a hand-rolled CRDT. Share the link, edit together, go offline, and everything merges when you come back.
      </p>
      <div className="card home-card">
        <label className="field">
          <span>Your display name</span>
          <input value={name} maxLength={30} onChange={(e) => setN(e.target.value)} />
        </label>
        <button className="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create a new board'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
      {recent.length > 0 && (
        <>
          <h2>Recent boards</h2>
          <div className="recent">
            {recent.map((b) => (
              <a key={b.id} className="card" href={`/b/${b.id}`} onClick={(e) => { e.preventDefault(); navigate(`/b/${b.id}`); }}>
                <strong>{b.title}</strong>
                <small className="muted">{new Date(b.at).toLocaleString()}</small>
              </a>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
