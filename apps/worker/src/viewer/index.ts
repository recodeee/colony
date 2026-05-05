import {
  type HivemindSnapshot,
  type MemoryStore,
  buildDiscrepancyReport,
  inferIdeFromSessionId,
} from '@colony/core';
import type { SessionRow } from '@colony/storage';
import { html, layout, raw } from './html.js';
import { renderAdoptionHealth } from './sections/adoption-health.js';
import { renderAttentionSidebar } from './sections/attention.js';
import {
  type BuildDiscrepancyReport,
  renderCoordinationBehavior,
} from './sections/coordination-behavior.js';
import { renderDiagnostic, renderToolUsageHistogram } from './sections/diagnostic.js';
import { buildFileHeatRows, renderFileHeatMap } from './sections/heat-map.js';
import { renderHivemindDashboard } from './sections/hivemind.js';
import { renderSavingsPage } from './sections/savings.js';
import { type StrandedSessionSummary, renderStrandedSessions } from './sections/stranded.js';

const DEFAULT_FILE_HEAT_HALF_LIFE_MINUTES = 30;

export type ClaimCoverageSnapshot = ReturnType<MemoryStore['storage']['claimCoverageSnapshot']>;
export type { StrandedSessionSummary };
export { buildFileHeatRows };
export { renderSavingsPage } from './sections/savings.js';
export type { SavingsPagePayload } from './sections/savings.js';
export { buildViewerAdoptionHealthPayload } from './sections/adoption-health.js';

export function buildClaimCoverageSnapshot(
  store: MemoryStore,
  since: number,
): ClaimCoverageSnapshot {
  return store.storage.claimCoverageSnapshot(since);
}

export function renderIndex(
  sessions: SessionRow[],
  snapshot: HivemindSnapshot | undefined,
  store: MemoryStore,
  strandedSessions: StrandedSessionSummary[] = [],
  reportBuilder: BuildDiscrepancyReport = buildDiscrepancyReport,
  fileHeatHalfLifeMinutes = DEFAULT_FILE_HEAT_HALF_LIFE_MINUTES,
): string {
  const stranded = renderStrandedSessions(strandedSessions);
  const dashboard = snapshot ? renderHivemindDashboard(snapshot) : '';
  const colonyState = renderColonyState(store, reportBuilder, fileHeatHalfLifeMinutes);
  if (sessions.length === 0) {
    return layout(
      'agents-hivemind',
      html`${raw(stranded)}${raw(dashboard)}${raw(colonyState)}<p>No memory sessions yet.</p>`,
    );
  }
  const ownerCounts = new Map<string, number>();
  const items = sessions
    .map((s) => {
      const owner = resolveOwner(s);
      ownerCounts.set(owner.ide, (ownerCounts.get(owner.ide) ?? 0) + 1);
      const cwdHtml = s.cwd ? html` · ${s.cwd}` : '';
      return html`
      <div class="card">
        <div>${raw(ownerChip(owner.ide, owner.derived))}<a href="/sessions/${s.id}"><strong>${s.id}</strong></a></div>
        <div class="meta">${new Date(s.started_at).toISOString()}${raw(cwdHtml)}</div>
      </div>`;
    })
    .join('');
  const summary = [...ownerCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([ide, n]) => html`<span class="owner" data-owner="${ide}">${ide} · ${n}</span>`)
    .join(' ');
  return layout(
    'agents-hivemind · sessions',
    html`<p class="meta"><a href="/savings">token savings &rarr;</a></p>${raw(stranded)}${raw(dashboard)}${raw(colonyState)}<h2>Recent memory sessions</h2><p class="meta">${raw(summary)}</p>${raw(items)}`,
  );
}

export function renderSession(
  session: SessionRow,
  observations: Array<{ id: number; kind: string; ts: number; content: string }>,
): string {
  const rows = observations
    .map(
      (o) => html`
      <div class="card">
        <div class="meta">#${o.id} · ${o.kind} · ${new Date(o.ts).toISOString()}</div>
        <pre>${o.content}</pre>
      </div>`,
    )
    .join('');
  const owner = resolveOwner(session);
  return layout(
    `agents-hivemind · ${session.id}`,
    html`<h2>${raw(ownerChip(owner.ide, owner.derived))}${session.id}</h2><p><a href="/">&larr; all sessions</a></p>${raw(rows)}`,
  );
}

function renderColonyState(
  store: MemoryStore,
  reportBuilder: BuildDiscrepancyReport,
  fileHeatHalfLifeMinutes: number,
): string {
  const storage = store.storage;
  const tasks = storage.listTasks(200).filter((task) => task.status === 'open');
  return html`
    <section>
      <h2>Canonical colony state</h2>
      <div class="viewer-grid">
        <div class="viewer-main">
          ${raw(renderDiagnostic(store))}
          ${raw(renderCoordinationBehavior(store, reportBuilder))}
          ${raw(renderAdoptionHealth(store))}
          ${raw(renderFileHeatMap(storage, tasks, fileHeatHalfLifeMinutes))}
          ${raw(renderToolUsageHistogram())}
        </div>
        ${raw(renderAttentionSidebar(tasks))}
      </div>
    </section>`;
}

function resolveOwner(session: SessionRow): { ide: string; derived: boolean } {
  const storedIde = session.ide;
  if (storedIde && storedIde !== 'unknown') return { ide: storedIde, derived: false };
  const metadataOwner = inferredOwnerFromMetadata(session.metadata);
  if (metadataOwner) return { ide: metadataOwner, derived: true };
  const inferred = inferIdeFromSessionId(session.id);
  if (inferred) return { ide: inferred, derived: true };
  return { ide: 'unbound', derived: true };
}

function ownerChip(ide: string, derived: boolean): string {
  const label = derived ? `${ide}?` : ide;
  return html`<span class="owner" data-owner="${ide}" data-derived="${String(derived)}">${label}</span>`;
}

function inferredOwnerFromMetadata(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agent = typeof parsed.inferred_agent === 'string' ? parsed.inferred_agent.trim() : '';
    if (agent && agent !== 'unknown' && agent !== 'unbound') {
      return agent === 'claude' ? 'claude-code' : agent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
