import type { Storage, TaskRow } from '@colony/storage';
import { html, raw } from '../html.js';

const FILE_HEAT_LIMIT = 24;

export interface ViewerFileHeatRow {
  file_path: string;
  heat: number;
  event_count: number;
  branch: string;
  last_seen: string;
  kind: 'file_activity';
}

export function buildFileHeatRows(
  storage: Storage,
  tasks: TaskRow[],
  fileHeatHalfLifeMinutes: number,
): ViewerFileHeatRow[] {
  const taskIds = tasks.map((task) => task.id);
  if (taskIds.length === 0) return [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return storage
    .fileHeat({
      task_ids: taskIds,
      now: Date.now(),
      half_life_minutes: fileHeatHalfLifeMinutes,
      limit: FILE_HEAT_LIMIT,
    })
    .map((row) => ({
      file_path: row.file_path,
      heat: row.heat,
      event_count: row.event_count,
      branch: taskById.get(row.task_id)?.branch ?? `task #${row.task_id}`,
      last_seen: new Date(row.last_activity_ts).toISOString(),
      kind: 'file_activity',
    }));
}

export function renderFileHeatMap(
  storage: Storage,
  tasks: TaskRow[],
  fileHeatHalfLifeMinutes: number,
): string {
  const heat = buildFileHeatRows(storage, tasks, fileHeatHalfLifeMinutes);
  if (heat.length === 0) {
    return html`
      <div class="card">
        <h2>File activity heat-map</h2>
        <div class="heat-map" data-file-heat-root data-file-heat-endpoint="/api/colony/file-heat">
          <p class="meta heat-map-status">No hot files across active tasks.</p>
        </div>
        <script type="module">${raw(fileHeatMapScript)}</script>
      </div>`;
  }

  return html`
    <div class="card">
      <h2>File activity heat-map</h2>
      <div class="heat-map" data-file-heat-root data-file-heat-endpoint="/api/colony/file-heat">
        <p class="meta heat-map-status">Loading file activity...</p>
      </div>
      <script type="module">${raw(fileHeatMapScript)}</script>
    </div>`;
}

const fileHeatMapScript = `
const root = document.querySelector('[data-file-heat-root]');

function formatAgo(lastSeen) {
  const ts = Date.parse(lastSeen);
  if (!Number.isFinite(ts)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function heatStyle(tile, heat) {
  const ratio = Math.max(0, Math.min(1, Number(heat) || 0));
  const hue = Math.round(35 + ratio * 110);
  const light = Math.round(16 + ratio * 5);
  const borderLight = Math.round(33 + ratio * 14);
  tile.style.background = 'hsl(' + hue + ' 42% ' + light + '%)';
  tile.style.borderColor = 'hsl(' + hue + ' 58% ' + borderLight + '%)';
}

function FileHeatTile(row) {
  const tile = document.createElement('article');
  tile.className = 'claim-tile';
  tile.title =
    row.file_path +
    ' · heat ' +
    Number(row.heat || 0).toFixed(3) +
    ' · ' +
    row.branch +
    ' · ' +
    formatAgo(row.last_seen);
  heatStyle(tile, row.heat);

  const path = document.createElement('code');
  path.textContent = row.file_path;

  const stats = document.createElement('div');
  stats.className = 'meta';
  stats.textContent =
    'heat ' + Number(row.heat || 0).toFixed(3) + ' · ' + Number(row.event_count || 0) + ' event(s)';

  const source = document.createElement('div');
  source.className = 'meta';
  source.textContent = row.branch + ' · ' + formatAgo(row.last_seen) + ' · ' + row.kind;

  tile.append(path, stats, source);
  return tile;
}

async function FileHeatMap() {
  if (!root) return;
  try {
    const endpoint = root.getAttribute('data-file-heat-endpoint') || '/api/colony/file-heat';
    const response = await fetch(endpoint);
    const rows = await response.json();
    root.replaceChildren();
    if (!Array.isArray(rows) || rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'meta heat-map-status';
      empty.textContent = 'No hot files across active tasks.';
      root.append(empty);
      return;
    }
    root.append(...rows.map(FileHeatTile));
  } catch {
    root.replaceChildren();
    const error = document.createElement('p');
    error.className = 'meta heat-map-status';
    error.textContent = 'Unable to load file activity heat-map.';
    root.append(error);
  }
}

void FileHeatMap();
`;
