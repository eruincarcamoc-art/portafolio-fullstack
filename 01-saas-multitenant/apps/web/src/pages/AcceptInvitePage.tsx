import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const { reload, selectWorkspace } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'error'>('working');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode ejecuta los efectos dos veces
    ran.current = true;
    const token = params.get('token');
    if (!token) { setState('error'); setMessage('Missing invitation token.'); return; }
    api<{ tenant: { id: string } }>('POST', '/invitations/accept', { token })
      .then(async (r) => { await reload(); selectWorkspace(r.tenant.id); navigate('/', { replace: true }); })
      .catch((e: Error) => { setState('error'); setMessage(e.message); });
  }, [params, reload, selectWorkspace, navigate]);

  return state === 'working' ? <p>Joining workspace…</p> : <p className="error">{message}</p>;
}
