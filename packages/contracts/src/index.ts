import colonyOmxLifecycleV1Schema from '../schemas/colony-omx-lifecycle-v1.schema.json';

export const COLONY_OMX_LIFECYCLE_V1_SCHEMA_ID =
  'https://schemas.colony.local/colony-omx-lifecycle-v1.schema.json';

export const colonyOmxLifecycleV1SchemaJson = colonyOmxLifecycleV1Schema;

export type ColonyOmxLifecycleEventName =
  | 'session_start'
  | 'task_bind'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'claim_result'
  | 'stop_intent'
  | 'finish_result';

export type ColonyOmxLifecycleStatus = 'ok' | 'warning' | 'error';

export interface ColonyOmxLifecycleResultCandidate {
  id?: string;
  task_id?: number;
  file_path?: string;
  repo_root?: string;
  branch?: string;
  reason?: string;
}

export interface ColonyOmxLifecycleResult {
  status: ColonyOmxLifecycleStatus;
  code: string;
  message: string;
  next_action: string;
  candidates: ColonyOmxLifecycleResultCandidate[];
}

export interface ColonyOmxLifecyclePathRef {
  path: string;
  role: 'target' | 'source' | 'destination' | 'input' | 'output' | 'unknown';
  kind: 'file' | 'directory' | 'pseudo';
  pseudo?: 'dev_null';
}

export interface ColonyOmxLifecycleToolInput {
  operation?: 'replace' | 'multi_replace' | 'write' | 'patch' | 'command' | 'unknown';
  paths?: ColonyOmxLifecyclePathRef[];
  command?: string;
  command_redacted?: boolean;
  input_summary?: string;
  edit_count?: number;
  file_count?: number;
  added_lines?: number;
  removed_lines?: number;
  byte_count?: number;
  redacted?: boolean;
}

export interface ColonyOmxLifecycleEnvelope {
  event_id: string;
  parent_event_id?: string;
  event_name: ColonyOmxLifecycleEventName;
  session_id: string;
  agent: string;
  cwd: string;
  repo_root: string;
  branch: string;
  timestamp: string;
  source: string;
  tool_name?: string;
  tool_input?: ColonyOmxLifecycleToolInput;
  result?: ColonyOmxLifecycleResult;
}
