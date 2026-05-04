export const FORAGING_CONCEPT_RULES = [
  {
    tag: 'outcome-learning',
    keywords: [
      'outcome',
      'outcomes',
      'debrief',
      'completion',
      'verification',
      'trajectory',
      'feedback',
    ],
    aliases: ['outcome learning', 'learn outcomes', 'failure learning'],
  },
  {
    tag: 'pattern-memory',
    keywords: ['pattern', 'patterns', 'memory', 'memories', 'observation', 'history', 'recall'],
    aliases: ['pattern memory', 'memory pattern', 'past patterns'],
  },
  {
    tag: 'trigger-routing',
    keywords: ['trigger', 'triggers', 'route', 'routing', 'router', 'classify', 'classification'],
    aliases: ['trigger routing', 'routing trigger', 'task routing'],
  },
  {
    tag: 'token-budget',
    keywords: ['token', 'tokens', 'budget', 'compact', 'hydrate', 'collapse', 'cost'],
    aliases: ['token budget', 'budget tokens', 'token cost'],
  },
  {
    tag: 'sidecar-runtime',
    keywords: [
      'sidecar',
      'runtime',
      'daemon',
      'worker',
      'background worker',
      'loop worker',
      'service',
    ],
    aliases: ['sidecar runtime', 'runtime sidecar', 'background runtime'],
  },
  {
    tag: 'mcp-bridge',
    keywords: ['mcp', 'model context protocol', 'mcp server', 'mcp tool', 'mcp tools', 'bridge'],
    aliases: ['mcp bridge', 'bridge mcp', 'mcp server'],
  },
  {
    tag: 'plugin-registry',
    keywords: [
      'plugin',
      'plugins',
      'plugin registry',
      'plugin marketplace',
      'plugin catalog',
      'plugin install',
    ],
    aliases: ['plugin registry', 'plugin marketplace', 'plugin catalog'],
  },
  {
    tag: 'tool-catalog',
    keywords: ['tool', 'tools', 'tool catalog', 'tool list', 'tool gallery', 'commands'],
    aliases: ['tool catalog', 'tool list', 'tool gallery'],
  },
  {
    tag: 'goal-planning',
    keywords: ['goal', 'goals', 'goal planner', 'goap', 'planning', 'plan tree', 'replanning'],
    aliases: ['goal planning', 'goal planner', 'goap planning'],
  },
  {
    tag: 'agentdb',
    keywords: ['agentdb', 'hnsw', 'hierarchical memory', 'semantic route', 'causal edge'],
    aliases: ['agentdb', 'agent db'],
  },
  {
    tag: 'ruvector',
    keywords: [
      'ruvector',
      '@ruvector',
      'vector search',
      'graph rag',
      'flashattention',
      'embeddings',
    ],
    aliases: ['ruvector', 'ru vector'],
  },
  {
    tag: 'federation',
    keywords: [
      'federation',
      'federated',
      'federation init',
      'federation join',
      'zero-trust',
      'trust scoring',
    ],
    aliases: ['federation', 'agent federation', 'federated agents'],
  },
  {
    tag: 'ready-work-ranking',
    keywords: ['ready work', 'ready-work', 'ranking', 'rank', 'priority', 'queue', 'triage'],
    aliases: ['ready work ranking', 'ready-work ranking', 'work ranking'],
  },
] as const;

export type ForagingConceptTag = (typeof FORAGING_CONCEPT_RULES)[number]['tag'];

export function detectForagingConceptTags(text: string): ForagingConceptTag[] {
  const hay = normalizeConceptText(text);
  const tags: ForagingConceptTag[] = [];
  for (const rule of FORAGING_CONCEPT_RULES) {
    if (rule.keywords.some((keyword) => hay.includes(keyword))) tags.push(rule.tag);
  }
  return tags;
}

export function expandForagingConceptQuery(query: string): string {
  const hay = normalizeConceptText(query);
  const extras: string[] = [];
  for (const rule of FORAGING_CONCEPT_RULES) {
    const tagAsWords = rule.tag.replaceAll('-', ' ');
    const exactTag = `concept=${rule.tag}`;
    const matched =
      hay.includes(exactTag) ||
      hay.includes(tagAsWords) ||
      rule.aliases.some((alias) => hay.includes(alias));
    if (!matched) continue;
    extras.push(tagAsWords);
  }
  const base = query.replace(/\bconcept=[a-z0-9-]+\b/gi, '').trim();
  if (extras.length === 0) return base || query;
  return `${base} ${dedupe(extras).join(' ')}`.trim();
}

function normalizeConceptText(text: string): string {
  return text.toLowerCase().replace(/[_/]+/g, ' ');
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
