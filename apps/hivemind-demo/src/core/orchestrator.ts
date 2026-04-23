import { BuilderAgent } from '../agents/builder.js';
import { CoordinatorAgent } from '../agents/coordinator.js';
import { ResearcherAgent } from '../agents/researcher.js';
import { ReviewerAgent } from '../agents/reviewer.js';
import { VerifierAgent } from '../agents/verifier.js';
import { createLogger } from '../utils/logger.js';
import { createCheckpoint, shouldCreateCheckpoint } from './checkpoint.js';
import { appendCheckpoint, applyAgentResult, createInitialState, incrementRetryCount, RunStore } from './state.js';
import type { Agent, AgentInput, AgentResult, OrchestratorOptions, RunState } from './types.js';

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_CHECKPOINT_INTERVAL = 2;

export class HivemindOrchestrator {
  private readonly coordinator = new CoordinatorAgent();
  private readonly researcher = new ResearcherAgent();
  private readonly builder = new BuilderAgent();
  private readonly reviewer = new ReviewerAgent();
  private readonly verifier = new VerifierAgent();
  private readonly options: OrchestratorOptions;

  constructor(options: Partial<OrchestratorOptions> = {}) {
    this.options = {
      dataDir: options.dataDir ?? 'data/runs',
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      checkpointInterval: options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
      logger: options.logger ?? createLogger(true),
    };
  }

  run(task: string): RunState {
    let state = createInitialState(task, this.options);
    const store = new RunStore(this.options.dataDir, state.runId);
    store.writeState(state);

    state = this.runAgent(this.coordinator, { task, phase: 'plan', attempt: 0 }, state, store);
    state = this.runAgent(this.researcher, { task, phase: 'research', attempt: 0 }, state, store);

    while (state.status === 'in_progress') {
      if (state.turn >= state.maxTurns) {
        return this.failForTurnBudget(state, store);
      }

      state = this.runAgent(this.builder, { task, phase: 'build', attempt: state.retryCount + 1 }, state, store);
      state = this.runAgent(this.reviewer, { task, phase: 'review', attempt: state.retryCount + 1 }, state, store);

      const decisionInput: AgentInput = {
        task,
        phase: 'decide',
        attempt: state.retryCount + 1,
      };
      const decisionResult = this.coordinator.run(decisionInput, state);
      state = this.commitResult(this.coordinator, decisionInput, state, decisionResult, store);

      if (decisionResult.decision === 'retry_builder') {
        state = incrementRetryCount(state);
        store.writeState(state);
        continue;
      }
      if (decisionResult.decision === 'send_to_verifier') {
        break;
      }
      if (decisionResult.decision === 'escalate') {
        return state;
      }
    }

    if (state.status !== 'in_progress') {
      return state;
    }
    if (state.turn >= state.maxTurns) {
      return this.failForTurnBudget(state, store);
    }

    return this.runAgent(this.verifier, { task, phase: 'verify', attempt: state.retryCount + 1 }, state, store);
  }

  private runAgent(agent: Agent, input: AgentInput, state: RunState, store: RunStore): RunState {
    const result = agent.run(input, state);
    return this.commitResult(agent, input, state, result, store);
  }

  private commitResult(
    agent: Agent,
    input: AgentInput,
    state: RunState,
    result: AgentResult,
    store: RunStore,
  ): RunState {
    this.options.logger?.info(`${agent.role}/${input.phase}: ${result.summary}`);
    let nextState = applyAgentResult(state, agent.role, input.phase, result);
    if (shouldCreateCheckpoint(nextState, this.options.checkpointInterval)) {
      const checkpoint = createCheckpoint(nextState);
      nextState = appendCheckpoint(nextState, checkpoint);
      store.writeCheckpoint(checkpoint);
    }
    store.writeState(nextState);
    store.writeFinal(nextState.finalResult);
    return nextState;
  }

  private failForTurnBudget(state: RunState, store: RunStore): RunState {
    const blocker = `Max turn limit (${state.maxTurns}) reached before verifier approval.`;
    const failedState: RunState = {
      ...state,
      status: 'failed',
      blockers: [...state.blockers, blocker],
    };
    store.writeState(failedState);
    return failedState;
  }
}
