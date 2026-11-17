import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';

export function AuthPage({ inviteHint = false }: { inviteHint?: boolean }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>(inviteHint ? 'login' : 'login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', workspaceName: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await login(f.email, f.password);
      else await register(f);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">▲ Tenantly</div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1>
        {inviteHint && <p className="notice">Sign in (or register) with the invited email to join the workspace, then reopen the invite link.</p>}
        {mode === 'register' && (
          <>
            <label className="field"><span>Your name</span><input required value={f.name} onChange={set('name')} /></label>
            <label className="field"><span>Workspace name</span><input required value={f.workspaceName} onChange={set('workspaceName')} /></label>
          </>
        )}
        <label className="field"><span>Email</span><input type="email" required value={f.email} onChange={set('email')} /></label>
        <label className="field">
          <span>Password</span>
          <input type="password" required minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={set('password')} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? "Don't have an account? Register" : 'Already registered? Sign in'}
        </button>
      </form>
    </div>
  );
}
