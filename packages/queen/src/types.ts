export interface Goal {
  title: string;
  problem: string;
  acceptance_criteria: string[];
  repo_root: string;
}

export interface QueenPlan {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  subtasks: SubtaskDraft[];
}

export interface SubtaskDraft {
  title: string;
  description: string;
  file_scope: string[];
  depends_on: string[];
  capability_hint: string;
  preferred_agent: string;
}
