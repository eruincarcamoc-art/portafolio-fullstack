import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './Home';
import { BoardPage } from './BoardPage';
import './styles.css';

function useRoute() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

function App() {
  const path = useRoute();
  const m = /^\/b\/([A-Za-z0-9_-]{16,64})(\?.*)?$/.exec(path);
  if (m) return <BoardPage key={m[1]} boardId={m[1]!} isNew={m[2]?.includes('new=1') ?? false} />;
  return <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
