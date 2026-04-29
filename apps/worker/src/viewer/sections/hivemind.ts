import { type HivemindSession, type HivemindSnapshot, inferIdeFromSessionId } from '@colony/core';
import { html, raw } from '../html.js';

export function renderHivemindDashboard(snapshot: HivemindSnapshot): string {
  const needsAttention = snapshot.sessions.filter((session) => laneNeedsAttention(session));
  const lanes = snapshot.sessions.length
    ? snapshot.sessions.map(renderLane).join('')
    : '<p class="meta">No active Hivemind lanes found for configured repo roots.</p>';

  return html`
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
          ? raw(
              html`<p><span class="badge" data-attention="true">${needsAttention.length} lane needs attention</span></p>`,
            )
          : raw('<p><span class="badge">runtime clean</span></p>')
      }
      ${raw(lanes)}
    </section>`;
}

function renderLane(session: HivemindSession): string {
  const attention = laneNeedsAttention(session);
  const lockSummary =
    session.locked_file_count > 0
      ? html`<div class="meta">GX locks ${session.locked_file_count}: ${session.locked_file_preview.join(', ')}</div>`
      : '';
  const ownerIde = laneOwnerIde(session);
  const ownerDerived = ownerIde !== session.agent && ownerIde !== session.cli;
  return html`
    <div class="card lane" data-attention="${String(attention)}">
      <div>${raw(ownerChip(ownerIde, ownerDerived))}<strong>${session.task || session.task_name || session.branch}</strong>
        <span class="badge" data-attention="${String(attention)}">${session.activity}</span></div>
      <div class="meta">${session.agent}/${session.cli} · ${session.branch} · ${session.source}</div>
      <div class="meta">${session.activity_summary} Updated ${session.updated_at || 'unknown'}.</div>
      ${raw(lockSummary)}
      <div class="meta">${session.worktree_path}</div>
    </div>`;
}

function ownerChip(ide: string, derived: boolean): string {
  const label = derived ? `${ide}?` : ide;
  return html`<span class="owner" data-owner="${ide}" data-derived="${String(derived)}">${label}</span>`;
}

function laneOwnerIde(session: HivemindSession): string {
  if (session.agent && session.agent !== 'agent') return session.agent;
  if (session.cli && session.cli !== 'unknown') return session.cli;
  const inferred = inferIdeFromSessionId(session.session_key);
  return inferred ?? 'unbound';
}

function laneNeedsAttention(session: HivemindSession): boolean {
  return ['dead', 'stalled', 'unknown'].includes(session.activity);
}
