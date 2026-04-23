import type { HivemindSession, HivemindSnapshot } from '@cavemem/core';
import type { SessionRow } from '@cavemem/storage';

const style = `
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #0b0d10; color: #e6e6e6; }
  header { padding: 16px 24px; border-bottom: 1px solid #222; }
  main { padding: 24px; max-width: 960px; margin: 0 auto; }
  a { color: #7aa2ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { background: #13161b; border: 1px solid #222; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 18px; }
  .stat { background: #151a22; border: 1px solid #263041; border-radius: 10px; padding: 12px 14px; }
  .stat strong { display: block; font-size: 22px; color: #f2f5f8; }
  .lane { border-left: 3px solid #50658a; }
  .lane[data-attention="true"] { border-left-color: #e7b85b; }
  .badge { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: #263041; color: #c9d4e5; font-size: 11px; }
  .badge[data-attention="true"] { background: #3b2d17; color: #ffd88a; }
  .meta { color: #8a94a3; font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  h2 { margin: 0 0 12px; font-size: 16px; color: #cfd5de; }
  code { background: #1d2129; padding: 1px 4px; border-radius: 3px; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${style}</style></head><body><header><h1>agents-hivemind</h1><div class="meta">local memory + runtime viewer</div></header><main>${body}</main></body></html>`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export function renderIndex(sessions: SessionRow[], snapshot?: HivemindSnapshot): string {
  const dashboard = snapshot ? renderHivemindDashboard(snapshot) : '';
  if (sessions.length === 0) {
    return layout('agents-hivemind', `${dashboard}<p>No memory sessions yet.</p>`);
  }
  const items = sessions
    .map(
      (s) => `
      <div class="card">
        <a href="/sessions/${esc(s.id)}"><strong>${esc(s.id)}</strong></a>
        <div class="meta">${esc(s.ide)} · ${esc(s.cwd ?? '')} · ${new Date(s.started_at).toISOString()}</div>
      </div>`,
    )
    .join('');
  return layout(
    'agents-hivemind · sessions',
    `${dashboard}<h2>Recent memory sessions</h2>${items}`,
  );
}

export function renderSession(
  session: SessionRow,
  observations: Array<{ id: number; kind: string; ts: number; content: string }>,
): string {
  const rows = observations
    .map(
      (o) => `
      <div class="card">
        <div class="meta">#${o.id} · ${esc(o.kind)} · ${new Date(o.ts).toISOString()}</div>
        <pre>${esc(o.content)}</pre>
      </div>`,
    )
    .join('');
  return layout(
    `agents-hivemind · ${session.id}`,
    `<h2>${esc(session.id)} <span class="meta">(${esc(session.ide)})</span></h2><p><a href="/">&larr; all sessions</a></p>${rows}`,
  );
}

function renderHivemindDashboard(snapshot: HivemindSnapshot): string {
  const needsAttention = snapshot.sessions.filter((session) => laneNeedsAttention(session));
  const lanes = snapshot.sessions.length
    ? snapshot.sessions.map(renderLane).join('')
    : '<p class="meta">No active Hivemind lanes found for configured repo roots.</p>';

  return `
    <section>
      <h2>Hivemind runtime</h2>
      <div class="grid">
        <div class="stat"><strong>${snapshot.session_count}</strong><span class="meta">live lanes</span></div>
        <div class="stat"><strong>${snapshot.counts.working}</strong><span class="meta">working</span></div>
        <div class="stat"><strong>${snapshot.counts.stalled + snapshot.counts.dead + snapshot.counts.unknown}</strong><span class="meta">attention</span></div>
        <div class="stat"><strong>${snapshot.repo_roots.length}</strong><span class="meta">repo roots</span></div>
      </div>
      ${
        needsAttention.length > 0
          ? `<p><span class="badge" data-attention="true">${needsAttention.length} lane needs attention</span></p>`
          : '<p><span class="badge">runtime clean</span></p>'
      }
      ${lanes}
    </section>`;
}

function renderLane(session: HivemindSession): string {
  const attention = laneNeedsAttention(session);
  return `
    <div class="card lane" data-attention="${String(attention)}">
      <strong>${esc(session.task || session.task_name || session.branch)}</strong>
      <span class="badge" data-attention="${String(attention)}">${esc(session.activity)}</span>
      <div class="meta">${esc(session.agent)}/${esc(session.cli)} · ${esc(session.branch)} · ${esc(session.source)}</div>
      <div class="meta">${esc(session.activity_summary)} Updated ${esc(session.updated_at || 'unknown')}.</div>
      <div class="meta">${esc(session.worktree_path)}</div>
    </div>`;
}

function laneNeedsAttention(session: HivemindSession): boolean {
  return ['dead', 'stalled', 'unknown'].includes(session.activity);
}
