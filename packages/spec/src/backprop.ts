import type { MemoryStore } from '@colony/core';
import { ProposalSystem } from '@colony/core';
import { SPEC_BRANCH_PREFIX, SPEC_OBSERVATION_KINDS } from './constants.js';

// A failure signature is the invariant key: (test-id, top-3 stack-frames,
// error-class). Two failures with the same signature are "the same bug
// class", which is exactly what we need for the promote_after threshold.
export interface FailureSignature {
  test_id: string;
  error_class: string;
  frames: string[];
  // The hash suffix used in §B rows, stored separately for compact
  // display: `auth-timeout:a3f9`.
  hash: string;
}

export interface PromotionDecision {
  action: 'append_only' | 'propose_invariant' | 'promote_existing';
  signature: FailureSignature;
  matchCount: number;
  proposal_id?: number;
}

// Build a stable signature from the raw failure fields. Normalization
// rules are deliberately strict so that whitespace, line numbers, and
// absolute path differences don't split a "same bug" into multiple
// signatures.
export function computeFailureSignature(input: {
  test_id: string;
  error: string;
  stack?: string;
}): FailureSignature {
  const errorClass = extractErrorClass(input.error);
  const frames = extractTopFrames(input.stack ?? '', 3);
  const keyString = [input.test_id, errorClass, ...frames].join('||');
  return {
    test_id: input.test_id,
    error_class: errorClass,
    frames,
    hash: shortHash(keyString),
  };
}

export interface BackpropGateOptions {
  store: MemoryStore;
  repoRoot: string;
  // From config.yaml: backprop.promote_after. Default 2.
  promoteAfter?: number;
  // Branch the backprop gate records promotions against. Conventionally
  // one per slug: `spec/<slug>` so each change gets its own bug-log.
  branch: string;
}

// The gate's job: given a failure signature, decide whether to
//   a) just append to §B (append_only — first occurrence)
//   b) propose a new §V draft via colony's ProposalSystem (propose_invariant)
//   c) reinforce an existing proposal (promote_existing)
//
// Crucially, the proposal mechanism is colony's existing one. We don't
// reinvent reinforcement, decay, or promotion — we just tell colony "here's
// another rediscovery of proposal N". Colony's 1-hour half-life and 2.5
// threshold do the rest.
export class BackpropGate {
  private readonly proposals: ProposalSystem;
  private readonly promoteAfter: number;

  constructor(private readonly opts: BackpropGateOptions) {
    this.proposals = new ProposalSystem(opts.store);
    this.promoteAfter = opts.promoteAfter ?? 2;
  }

  // Called by /co:build when a test fails. Returns the decision so the
  // build skill can render the right user-facing message.
  recordFailure(input: {
    task_id: number;
    session_id: string;
    agent: string;
    signature: FailureSignature;
    error_summary: string;
  }): PromotionDecision {
    // Every failure always appends a §B row; that's non-negotiable.
    this.opts.store.addObservation({
      session_id: input.session_id,
      kind: SPEC_OBSERVATION_KINDS.SPEC_BUG,
      content: formatBugRow(input.signature, input.error_summary),
      task_id: input.task_id,
      metadata: {
        signature_hash: input.signature.hash,
        test_id: input.signature.test_id,
        error_class: input.signature.error_class,
      },
    });

    // How many prior failures share this signature on this task?
    const matchCount = this.countPriorMatches(input.task_id, input.signature.hash);

    if (matchCount + 1 < this.promoteAfter) {
      return { action: 'append_only', signature: input.signature, matchCount: matchCount + 1 };
    }

    // Threshold crossed. Look for an existing proposal keyed on this
    // signature. If one exists, reinforce (rediscovered). If not, propose.
    const existing = this.findExistingProposal(input.signature.hash);
    if (existing) {
      const { strength, promoted } = this.proposals.reinforce({
        proposal_id: existing,
        session_id: input.session_id,
        kind: 'rediscovered',
      });
      return {
        action: 'promote_existing',
        signature: input.signature,
        matchCount: matchCount + 1,
        proposal_id: existing,
      };
    }

    const proposal_id = this.proposals.propose({
      repo_root: this.opts.repoRoot,
      branch: this.opts.branch,
      summary: invariantSummary(input.signature),
      rationale: invariantRationale(input.signature, input.error_summary, matchCount + 1),
      touches_files: [],
      session_id: input.session_id,
    });

    // Record the signature -> proposal_id mapping so future same-sig
    // failures find it via findExistingProposal. We put this in the
    // proposal's own observation metadata by appending a SPEC_INVARIANT_DRAFT
    // observation tagged with the signature hash.
    this.opts.store.addObservation({
      session_id: input.session_id,
      kind: SPEC_OBSERVATION_KINDS.SPEC_INVARIANT_DRAFT,
      content: `Draft invariant for signature ${input.signature.hash}; proposal_id=${proposal_id}`,
      task_id: input.task_id,
      metadata: {
        signature_hash: input.signature.hash,
        proposal_id,
      },
    });

    return {
      action: 'propose_invariant',
      signature: input.signature,
      matchCount: matchCount + 1,
      proposal_id,
    };
  }

  // Lookahead: given a task-signature (the task's cites + verbs), return
  // archived bug entries whose signatures are similar. The exact simi-
  // larity is BM25 + optional semantic re-rank via colony's search —
  // we delegate to MemoryStore.search() rather than reimplementing it.
  //
  // Called by /co:build before executing a task, so the agent sees
  // "this pattern previously failed when..." as preamble.
  async lookahead(taskSignature: string, limit = 3): Promise<Array<{ id: number; snippet: string }>> {
    const hits = await this.opts.store.search(taskSignature, limit);
    return hits
      .filter((h) => h.snippet.includes('BUG:') || /signature_hash/.test(h.snippet))
      .map((h) => ({ id: h.id, snippet: h.snippet }));
  }

  // ---- private --------------------------------------------------------

  private countPriorMatches(task_id: number, signatureHash: string): number {
    // Pull all SPEC_BUG observations on this task and count by signature.
    // For a typical change this is tens to hundreds of rows, well below
    // the threshold where we'd need a separate index.
    const all = this.opts.store.storage.taskTimeline(task_id, 500);
    let n = 0;
    for (const obs of all) {
      if (obs.kind !== SPEC_OBSERVATION_KINDS.SPEC_BUG) continue;
      const meta = safeJson(obs.metadata) as { signature_hash?: string };
      if (meta.signature_hash === signatureHash) n++;
    }
    return n;
  }

  private findExistingProposal(signatureHash: string): number | undefined {
    // We indexed the proposal_id on the SPEC_INVARIANT_DRAFT observation
    // when it was created. Scan the whole spec lane's observations for
    // that signature hash.
    const tasks = this.opts.store.storage.listTasks(200);
    for (const t of tasks) {
      if (!t.branch.startsWith(SPEC_BRANCH_PREFIX)) continue;
      const rows = this.opts.store.storage.taskTimeline(t.id, 500);
      for (const obs of rows) {
        if (obs.kind !== SPEC_OBSERVATION_KINDS.SPEC_INVARIANT_DRAFT) continue;
        const meta = safeJson(obs.metadata) as { signature_hash?: string; proposal_id?: number };
        if (meta.signature_hash === signatureHash && typeof meta.proposal_id === 'number') {
          return meta.proposal_id;
        }
      }
    }
    return undefined;
  }
}

function extractErrorClass(error: string): string {
  // "TypeError: foo is not a function" -> "TypeError"
  // "AssertionError [ERR_ASSERTION]: ..." -> "AssertionError"
  const m = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception))/.exec(error.trim());
  return m ? m[1] : 'Error';
}

function extractTopFrames(stack: string, n: number): string[] {
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const m = /\bat\s+([^\s(]+)\s*\(?([^:)]+):\d+:\d+\)?/.exec(line);
    if (m) {
      // function-name @ file (stripping line numbers so same code in
      // different commits hashes the same).
      frames.push(`${m[1]}@${basename(m[2])}`);
      if (frames.length >= n) break;
    }
  }
  return frames;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function shortHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).slice(0, 4);
}

function formatBugRow(sig: FailureSignature, summary: string): string {
  // The compact §B row format: `<signature>|<test_id>|<error_class>|<summary>`
  return `BUG:${sig.hash}|${sig.test_id}|${sig.error_class}|${summary}`;
}

function invariantSummary(sig: FailureSignature): string {
  return `Prevent recurrence of ${sig.error_class} in ${sig.test_id}`;
}

function invariantRationale(sig: FailureSignature, error_summary: string, count: number): string {
  return [
    `Signature ${sig.hash} has fired ${count} time(s).`,
    `Test: ${sig.test_id}`,
    `Class: ${sig.error_class}`,
    `Summary: ${error_summary}`,
    `Top frames: ${sig.frames.join(' / ')}`,
    '',
    'This proposal will be promoted to a real §V invariant once collective reinforcement crosses the threshold.',
  ].join('\n');
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
