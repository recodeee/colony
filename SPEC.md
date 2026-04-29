# SPEC

## §G  goal
Colony provides local-first coordination, memory, planning, and health signals for coding agents.

## §C  constraints
- Keep coordination state auditable through task threads and observations.
- Prefer compact, claimable plans for multi-agent execution.

## §I  interfaces
- MCP tools publish, claim, complete, and inspect Colony plans.
- CLI health reports readiness for coordination, execution safety, and Queen plans.

## §V  invariants
id|rule|cites
-|-|-
V1.always|Published plans must expose claimable subtasks through task_ready_for_agent.|-
V2.always|Health must report active Queen plans, plan subtasks, and ready work from the plan substrate.|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|Keep Queen plan readiness nonzero when active plans have available first-wave work.|V1.always,V2.always

## §B  bugs
id|bug|cites
-|-|-
