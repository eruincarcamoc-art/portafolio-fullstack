import { useEffect, useRef, useState } from 'react';
import type { CardView, ColumnView, Peer, SyncClient } from '@collab/core';
import { useBoard } from './useBoard';
import { getIdentity, rememberBoard } from './identity';
import { navigate } from './router';

interface DropTarget {
  col: string;
  index: number;
}

export function BoardPage({ boardId, isNew }: { boardId: string; isNew: boolean }) {
  const { client, columns, status, peers, pending, error } = useBoard(boardId, isNew);
  const [drag, setDrag] = useState<{ card: string } | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [offlineByUser, setOfflineByUser] = useState(false);
  const [copied, setCopied] = useState(false);
  const me = getIdentity();

  useEffect(() => {
    document.title = 'Collab Board';
    rememberBoard(boardId, `Board ${boardId.slice(0, 6)}`);
    if (isNew) history.replaceState(null, '', `/b/${boardId}`);
  }, [boardId, isNew]);

  // Quién está mirando / editando qué tarjeta.
  const focusBy = new Map<string, Peer[]>();
  for (const p of peers) if (p.focus) focusBy.set(p.focus, [...(focusBy.get(p.focus) ?? []), p]);

  function toggleOffline() {
    if (offlineByUser) client.connect();
    else client.close();
    setOfflineByUser(!offlineByUser);
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link', location.href);
    }
  }

  function onDrop() {
    if (drag && drop) client.doc.moveCard(drag.card, drop.col, drop.index);
    setDrag(null);
    setDrop(null);
  }

  return (
    <div className="board-page">
      <header className="topbar">
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} className="logo">▦ Collab Board</a>
        <div className="topbar-right">
          <StatusPill status={status} pending={pending} />
          <div className="avatars" aria-label="People on this board">
            <span className="avatar" style={{ background: me.color }} title={`${me.name} (you)`}>{initials(me.name)}</span>
            {peers.map((p) => (
              <span key={p.id} className="avatar" style={{ background: p.color }} title={p.name + (p.editing ? ' is editing' : '')}>{initials(p.name)}</span>
            ))}
          </div>
          <button className="ghost small" onClick={toggleOffline} title="Simulate losing the network">
            {offlineByUser ? 'Go online' : 'Go offline'}
          </button>
          <button className="primary small" onClick={share}>{copied ? 'Link copied!' : 'Share'}</button>
        </div>
      </header>

      {error && <p className="banner">{error}</p>}

      <div className="columns" onDragEnd={() => { setDrag(null); setDrop(null); }}>
        {columns.map((col) => (
          <Column
            key={col.id}
            col={col}
            client={client}
            drag={drag}
            drop={drop}
            focusBy={focusBy}
            onDragStart={(id) => setDrag({ card: id })}
            onTarget={setDrop}
            onDrop={onDrop}
          />
        ))}
        <button className="add-column" onClick={() => { const t = window.prompt('Column title'); if (t?.trim()) client.doc.createColumn(t.trim()); }}>
          + Add column
        </button>
      </div>
      {columns.length === 0 && status === 'online' && <p className="muted center">This board is empty.</p>}
    </div>
  );
}

function Column(props: {
  col: ColumnView;
  client: SyncClient;
  drag: { card: string } | null;
  drop: DropTarget | null;
  focusBy: Map<string, Peer[]>;
  onDragStart(id: string): void;
  onTarget(t: DropTarget | null): void;
  onDrop(): void;
}) {
  const { col, client, drag, drop } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  /** El índice de destino se calcula comparando el cursor con el punto medio de cada tarjeta. */
  function onDragOver(e: React.DragEvent) {
    if (!drag) return;
    e.preventDefault();
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []).filter((el) => el.dataset.card !== drag.card);
    let index = els.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    if (drop?.col !== col.id || drop.index !== index) props.onTarget({ col: col.id, index });
  }

  function addCard() {
    if (title.trim()) client.doc.createCard(col.id, title.trim());
    setTitle('');
    setAdding(false);
  }

  const visible = col.cards.filter((c) => c.id !== drag?.card);
  const showAt = drag && drop?.col === col.id ? drop.index : -1;

  return (
    <section className="column" onDragOver={onDragOver} onDrop={(e) => { e.preventDefault(); props.onDrop(); }}>
      <header className="column-head">
        <EditableText
          value={col.title}
          className="column-title"
          onCommit={(v) => v && v !== col.title && client.doc.renameColumn(col.id, v)}
        />
        <span className="count">{col.cards.length}</span>
        <button className="icon" title="Delete column" onClick={() => window.confirm(`Delete column "${col.title}"?`) && client.doc.deleteColumn(col.id)}>×</button>
      </header>
      <div className="cards" ref={listRef}>
        {visible.map((card, i) => (
          <div key={card.id}>
            {showAt === i && <div className="drop-line" />}
            <CardItem card={card} client={client} peers={props.focusBy.get(card.id) ?? []} onDragStart={() => props.onDragStart(card.id)} />
          </div>
        ))}
        {showAt >= visible.length && showAt !== -1 && <div className="drop-line" />}
      </div>
      {adding ? (
        <div className="add-card">
          <textarea
            autoFocus
            placeholder="Card title…"
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(); } if (e.key === 'Escape') setAdding(false); }}
          />
          <div className="row">
            <button className="primary small" onClick={addCard}>Add</button>
            <button className="ghost small" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="add-card-btn" onClick={() => setAdding(true)}>+ Add a card</button>
      )}
    </section>
  );
}

function CardItem({ card, client, peers, onDragStart }: { card: CardView; client: SyncClient; peers: Peer[]; onDragStart(): void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [desc, setDesc] = useState(card.desc);
  const lead = peers[0];

  // Si otro usuario cambia la tarjeta mientras NO la editamos, mostramos su versión.
  useEffect(() => {
    if (!editing) { setTitle(card.title); setDesc(card.desc); }
  }, [card.title, card.desc, editing]);

  function startEdit() {
    setEditing(true);
    client.setPresence(card.id, true);
  }
  function save() {
    client.doc.editCard(card.id, { ...(title.trim() && title !== card.title ? { title: title.trim() } : {}), ...(desc !== card.desc ? { desc } : {}) });
    setEditing(false);
    client.setPresence(null, false);
  }

  const style = lead ? { outline: `2px solid ${lead.color}`, outlineOffset: '1px' } : undefined;

  if (editing) {
    return (
      <div className="card-item editing" style={style}>
        <input autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setEditing(false), client.setPresence(null, false))} />
        <textarea placeholder="Description" value={desc} maxLength={5000} onChange={(e) => setDesc(e.target.value)} />
        <div className="row">
          <button className="primary small" onClick={save}>Save</button>
          <button className="ghost small" onClick={() => { setEditing(false); client.setPresence(null, false); }}>Cancel</button>
          <button className="danger small push" onClick={() => { client.doc.deleteCard(card.id); client.setPresence(null, false); }}>Delete</button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="card-item"
      data-card={card.id}
      draggable
      style={style}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); onDragStart(); }}
      onClick={startEdit}
      onMouseEnter={() => client.setPresence(card.id, false)}
      onMouseLeave={() => client.setPresence(null, false)}
    >
      <p>{card.title}</p>
      {card.desc && <small className="muted">{card.desc.slice(0, 80)}{card.desc.length > 80 ? '…' : ''}</small>}
      {lead && <span className="presence-tag" style={{ background: lead.color }}>{lead.editing ? `${lead.name} is editing` : lead.name}</span>}
    </div>
  );
}

function EditableText({ value, onCommit, className }: { value: string; onCommit(v: string): void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  if (!editing) return <h2 className={className} onClick={() => setEditing(true)}>{value}</h2>;
  const done = () => { setEditing(false); onCommit(v.trim()); };
  return <input autoFocus className={className} value={v} maxLength={100} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && done()} />;
}

function StatusPill({ status, pending }: { status: string; pending: number }) {
  const label = status === 'online' ? (pending ? `Syncing ${pending}…` : 'Synced') : status === 'connecting' ? 'Connecting…' : pending ? `Offline · ${pending} pending` : 'Offline';
  return <span className={`pill pill-${status}`}><i />{label}</span>;
}

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
