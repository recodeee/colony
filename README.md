# agents (ants) hivemind

**A biologically-grounded hivemind for AI coding agents.**

cavemem is a local-first memory and coordination system that lets multiple AI coding agents — Claude Code, Codex, Cursor, and friends — work on the same codebase without stepping on each other. It persists memory across sessions, surfaces what other agents are doing in real time, and coordinates their work through mechanisms borrowed directly from ant colonies: chemical-trail-style signals that strengthen with use and fade without it.

The design choice worth pausing on, because it's the thing that makes cavemem different from conventional coordination tools, is the decision to borrow from biology rather than from distributed systems textbooks. Ant colonies have been stress-testing their coordination protocols for about 150 million years, which means any pattern we take from them has already been debugged against failure modes we haven't even imagined yet. What ants use is not messaging and not shared state in the usual programmer's sense — it's *stigmergy*, coordination through traces left in a shared environment. cavemem applies exactly that pattern to AI agents.

Important current-state note: the published CLI and package names are still `cavemem`, so the commands below use `cavemem` even though this repository is branded as `agents-hivemind`. IDE MCP installs register the server as `colony`, so agent tool calls use the `colony` namespace.

## The core idea: stigmergy

The fundamental pattern underneath everything cavemem does is that agents never talk to each other directly. Instead, each agent leaves traces in a shared environment, and those traces influence what the other agents choose to do next. It's the same mechanism an ant colony uses to solve surprisingly sophisticated coordination problems — finding the shortest path to food, building a ventilated nest, allocating workers to tasks — without any individual ant knowing the colony's plan, because there *is* no colony plan. There's just the environment, the trail-laying behavior, and the rules each ant follows.

<p align="center">
  <svg viewBox="0 0 700 320" xmlns="http://www.w3.org/2000/svg" role="img" width="100%" style="max-width: 700px">
    <title>Stigmergy: the core coordination pattern in cavemem</title>
    <desc>Two agents interact through a shared environment containing pheromones, proposals, and task threads, rather than communicating directly.</desc>
    <defs>
      <marker id="arr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 Z" fill="#6b7280"/>
      </marker>
    </defs>
    <g stroke="#3b82f6" stroke-width="2" fill="none">
      <circle cx="90" cy="160" r="52"/>
      <text x="90" y="155" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="600" fill="#3b82f6" stroke="none">Claude</text>
      <text x="90" y="173" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#3b82f6" stroke="none">session</text>
    </g>
    <g stroke="#3b82f6" stroke-width="2" fill="none">
      <circle cx="610" cy="160" r="52"/>
      <text x="610" y="155" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="600" fill="#3b82f6" stroke="none">Codex</text>
      <text x="610" y="173" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#3b82f6" stroke="none">session</text>
    </g>
    <g stroke="#d97706" stroke-width="2" fill="none">
      <rect x="230" y="70" width="240" height="180" rx="12"/>
      <text x="350" y="100" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#d97706" stroke="none">Shared environment</text>
      <line x1="260" y1="115" x2="440" y2="115" stroke="#d97706" opacity="0.3"/>
      <text x="350" y="145" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#d97706" stroke="none">pheromones on files</text>
      <text x="350" y="170" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#d97706" stroke="none">proposals (weak trails)</text>
      <text x="350" y="195" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#d97706" stroke="none">task threads</text>
      <text x="350" y="225" text-anchor="middle" font-family="sans-serif" font-size="11" font-style="italic" fill="#d97706" stroke="none" opacity="0.75">SQLite-backed, local-first</text>
    </g>
    <g stroke="#6b7280" stroke-width="1.5" fill="none" marker-end="url(#arr1)">
      <path d="M 144 140 Q 185 100 230 100"/>
      <path d="M 230 220 Q 185 220 144 185"/>
    </g>
    <text x="175" y="92" font-family="sans-serif" font-size="11" fill="#6b7280">deposits</text>
    <text x="175" y="235" font-family="sans-serif" font-size="11" fill="#6b7280">perceives</text>
    <g stroke="#6b7280" stroke-width="1.5" fill="none" marker-end="url(#arr1)">
      <path d="M 556 140 Q 515 100 470 100"/>
      <path d="M 470 220 Q 515 220 556 185"/>
    </g>
    <text x="485" y="92" font-family="sans-serif" font-size="11" fill="#6b7280">deposits</text>
    <text x="485" y="235" font-family="sans-serif" font-size="11" fill="#6b7280">perceives</text>
    <text x="350" y="295" text-anchor="middle" font-family="sans-serif" font-size="12" font-style="italic" fill="#6b7280">
      No direct messaging. Coordination emerges from traces in the environment.
    </text>
  </svg>
</p>

Notice what's *missing* from the diagram: there's no arrow between Claude and Codex. Agents never see each other directly. What Claude sees is the environment — specifically, the pheromones and proposals and task threads that Codex has left behind. And what Codex sees, when it makes a decision, is the environment as Claude has most recently shaped it. This indirection is the whole trick. Because the environment is the shared medium, there's no need for a central coordinator, no need for a messaging protocol, no need for any agent to know about any other agent's internal state. The environment is the communication channel, and the traces are the messages.

The concrete instantiation of this abstract environment is a SQLite database at `~/.cavemem/data.db`, with tables for memory observations, task threads, pheromones, proposals, and so on. But the conceptual model — the thing that determines how the pieces fit together — is the ant colony.

## Why ants specifically, and not some other biological metaphor?

A fair question, because nature has plenty of other coordination patterns. Beehives do something similar. Starling murmurations are collective without being hive-structured. Slime molds solve maze problems through gradient-following. So why ants, specifically, as the inspiration for cavemem?

The answer is that ants are the biological organism whose coordination problems most closely resemble what a group of AI coding agents faces. Ants deal with *persistent work over time* — a foraging expedition isn't a momentary decision, it's a sustained activity that other ants need to be able to join and leave. They deal with *partial information* — no ant sees the whole picture, each one only knows what's immediately in front of it. They deal with *asynchronous participation* — ants don't all work at the same time, they come and go, and the trail system handles that gracefully. And they deal with *graceful degradation* — a colony that loses a third of its workers doesn't collapse, it just moves a little slower. All four properties are exactly what you need in a multi-agent coding system where agents start and stop independently, know only their own context, and need the system to keep working even when one of them goes quiet.

The other biological systems don't quite fit. Beehives solve similar problems but with more centralized information flow (the waggle dance announces specific coordinates, which is more like messaging than stigmergy). Starling murmurations are wonderful but don't have persistent work — each bird just reacts to neighbors in the moment. Slime molds are amazing but solve fundamentally different problems. Ants, for the specific shape of "multiple long-lived agents working on the same codebase," are just the right abstraction.

## The three mechanisms

cavemem takes three specific mechanisms from ant coordination and implements each one on top of its SQLite substrate. These three mechanisms compose to produce the full system, but each one also stands alone and addresses a specific coordination failure mode. Let me walk through each in turn.

### Mechanism one: pheromones

The first and most fundamental mechanism is the pheromone trail. When an ant walks over a surface, it deposits a small amount of pheromone. Other ants sense the pheromone and are more likely to follow paths where the trail is strong. Critically, pheromones have three properties that make the whole system robust: they have **strength** (a quantity, not just a yes/no), they **decay** exponentially over time, and they get **reinforced** by repeated use. A trail that's useful gets walked more, which means more pheromone is deposited, which means the trail stays strong. A trail that leads nowhere useful doesn't get reinforced, so the pheromone evaporates and the trail disappears.

This is dramatically different from how most software systems handle "someone is working on this" state. Your typical file-locking or claim system is binary (either claimed or not), static (it stays until explicitly released), and requires an agent to remember to release when done. Pheromones fix all three of these limitations at once. They're graded, so a file that's been edited ten times in the last minute looks meaningfully different from one edited once an hour ago. They're time-sensitive, so nobody has to remember to release claims — the universe forgets them automatically. And they're reinforced by actual use, so they accurately reflect what agents are currently focused on rather than what they said they'd do.

<p align="center">
  <svg viewBox="0 0 700 360" xmlns="http://www.w3.org/2000/svg" role="img" width="100%" style="max-width: 700px">
    <title>Pheromone strength over time with decay and reinforcement</title>
    <desc>Exponential decay curve showing pheromone strength halving every 10 minutes. One trail is reinforced by repeated deposits and stays strong; another is not reinforced and fades below the noise threshold.</desc>
    <text x="350" y="28" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#374151">
      Pheromone strength over time
    </text>
    <g stroke="#9ca3af" stroke-width="1" fill="none">
      <line x1="70" y1="300" x2="660" y2="300"/>
      <line x1="70" y1="300" x2="70" y2="60"/>
    </g>
    <g font-family="sans-serif" font-size="11" fill="#6b7280">
      <text x="62" y="65" text-anchor="end">1.0</text>
      <text x="62" y="130" text-anchor="end">0.75</text>
      <text x="62" y="185" text-anchor="end">0.5</text>
      <text x="62" y="245" text-anchor="end">0.25</text>
      <text x="62" y="305" text-anchor="end">0</text>
      <text x="28" y="180" text-anchor="middle" font-size="12" fill="#374151" transform="rotate(-90 28 180)">strength</text>
    </g>
    <g font-family="sans-serif" font-size="11" fill="#6b7280">
      <text x="70" y="320" text-anchor="middle">0</text>
      <text x="218" y="320" text-anchor="middle">10 min</text>
      <text x="366" y="320" text-anchor="middle">20 min</text>
      <text x="514" y="320" text-anchor="middle">30 min</text>
      <text x="655" y="320" text-anchor="middle">40 min</text>
      <text x="365" y="345" text-anchor="middle" font-size="12" fill="#374151">time since deposit</text>
    </g>
    <g stroke="#9ca3af" stroke-width="1" stroke-dasharray="3 3" fill="none" opacity="0.7">
      <line x1="218" y1="185" x2="218" y2="300"/>
      <line x1="70" y1="185" x2="218" y2="185"/>
    </g>
    <text x="222" y="180" font-family="sans-serif" font-size="10" fill="#6b7280" font-style="italic">half-life (10 min)</text>
    <line x1="70" y1="280" x2="660" y2="280" stroke="#dc2626" stroke-width="1" stroke-dasharray="5 3" fill="none" opacity="0.6"/>
    <text x="655" y="275" text-anchor="end" font-family="sans-serif" font-size="10" fill="#dc2626">noise floor (0.1)</text>
    <path d="M 70,65 Q 140,125 218,185 Q 290,230 360,258 Q 430,275 500,286 Q 570,292 660,297"
          stroke="#d97706" stroke-width="2" stroke-dasharray="6 3" fill="none" opacity="0.65"/>
    <text x="495" y="272" font-family="sans-serif" font-size="11" fill="#d97706" font-style="italic">unreinforced trail — decays away</text>
    <path d="M 70,65 Q 120,95 170,125"
          stroke="#059669" stroke-width="2.5" fill="none"/>
    <line x1="170" y1="125" x2="170" y2="80" stroke="#059669" stroke-width="2.5"/>
    <path d="M 170,80 Q 220,115 280,150"
          stroke="#059669" stroke-width="2.5" fill="none"/>
    <line x1="280" y1="150" x2="280" y2="85" stroke="#059669" stroke-width="2.5"/>
    <path d="M 280,85 Q 340,130 400,170 Q 460,205 520,235 Q 580,260 640,280"
          stroke="#059669" stroke-width="2.5" fill="none"/>
    <text x="340" y="115" font-family="sans-serif" font-size="11" fill="#059669" font-weight="600">reinforced trail — stays hot</text>
    <circle cx="70" cy="65" r="4" fill="#059669"/>
    <circle cx="170" cy="80" r="4" fill="#059669"/>
    <circle cx="280" cy="85" r="4" fill="#059669"/>
    <text x="76" y="56" font-family="sans-serif" font-size="10" fill="#059669">deposit</text>
    <text x="176" y="71" font-family="sans-serif" font-size="10" fill="#059669">reinforce</text>
    <text x="286" y="76" font-family="sans-serif" font-size="10" fill="#059669">reinforce</text>
  </svg>
</p>

The math underneath this picture is one line: `strength(t) = deposit × exp(-λ × elapsed_ms)`, where `λ` is chosen to give a ten-minute half-life. What's beautiful about this formula, and what makes the whole system cheap to implement, is that you never actually have to run a decay process. No cron job ages rows, no cleanup task scans the table. You just store when a pheromone was deposited and how strong the deposit was, and current strength is always computed fresh when someone asks for it. Time does the decaying for free.

In code, this lives in `packages/core/src/pheromone.ts` as a `PheromoneSystem` class with three methods. Calling `deposit()` is how an edit leaves its mark — the `PostToolUse` hook invokes this whenever Claude or Codex uses an `Edit`, `Write`, or `MultiEdit` tool. Calling `sniff()` reports the current strength on a specific file, decomposed by which session deposited what. Calling `strongestTrails()` returns the hottest files on a task right now, which is what powers both the `observe` dashboard's heat-map view and the conflict warnings in the `UserPromptSubmit` preface. The whole thing is maybe 120 lines of code and one small SQL table.

### Mechanism two: foraging for improvements

The second mechanism is where cavemem starts to do something genuinely novel, and it's the one that most closely maps onto the Ant Colony Optimization algorithms that computer scientists rediscovered in the 1990s. The biological setup: when a scout ant finds a potential food source, it doesn't immediately mobilize the colony. It lays a weak trail — an announcement with low confidence. If the food turns out to be rich, returning foragers reinforce the trail and more ants come to exploit it. If the food is mediocre, the trail isn't reinforced, decays quickly, and the colony's attention goes elsewhere. Critically, the ant that made the original discovery has no power to *declare* the food source important. Importance is decided collectively, by whether other ants return to it.

The same mechanism works beautifully for **agents proposing improvements to a codebase**. Any agent, while working on its current task, can notice something worth doing later — "the compression layer has a performance edge case," "the MCP error handling is inconsistent," "the viewer could use a search box." Rather than either ignoring these observations or immediately pivoting to address them, an agent files a *proposal*, which is the equivalent of laying a weak trail. If the proposal is actually a good idea, other agents working in adjacent code will reinforce it — either explicitly (voting for it) or implicitly (by editing files the proposal would touch, which counts as weaker evidence of shared interest). When total reinforcement crosses a threshold, the proposal is automatically promoted to a real task, which then runs through cavemem's normal task-thread machinery. If the proposal never attracts reinforcement, it decays below the noise floor and quietly disappears.

<p align="center">
  <svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg" role="img" width="100%" style="max-width: 700px">
    <title>Proposal lifecycle: reinforcement leads to promotion, neglect leads to evaporation</title>
    <desc>Two parallel timelines show a proposal being reinforced by multiple agents and crossing the promotion threshold to become a real task, versus a proposal that attracts no reinforcement and decays below the noise floor.</desc>
    <text x="350" y="28" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#374151">
      Proposal lifecycle: foraging for improvements
    </text>
    <line x1="350" y1="50" x2="350" y2="380" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="155" y="68" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#059669">Reinforced → promoted</text>
    <text x="545" y="68" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#dc2626">Unreinforced → evaporated</text>
    <g stroke="#9ca3af" stroke-width="1" fill="none">
      <line x1="50" y1="340" x2="300" y2="340"/>
      <line x1="50" y1="340" x2="50" y2="90"/>
    </g>
    <g stroke="#9ca3af" stroke-width="1" fill="none">
      <line x1="400" y1="340" x2="650" y2="340"/>
      <line x1="400" y1="340" x2="400" y2="90"/>
    </g>
    <g font-family="sans-serif" font-size="10" fill="#6b7280">
      <text x="45" y="95" text-anchor="end">strong</text>
      <text x="45" y="345" text-anchor="end">weak</text>
      <text x="175" y="358" text-anchor="middle">time →</text>
      <text x="395" y="95" text-anchor="end">strong</text>
      <text x="395" y="345" text-anchor="end">weak</text>
      <text x="525" y="358" text-anchor="middle">time →</text>
    </g>
    <line x1="50" y1="165" x2="300" y2="165" stroke="#059669" stroke-width="1" stroke-dasharray="5 3" opacity="0.7"/>
    <text x="296" y="160" text-anchor="end" font-family="sans-serif" font-size="10" fill="#059669">promotion threshold</text>
    <path d="M 65,320 L 85,305 L 105,310 L 125,260 L 150,240 L 180,185 L 210,160 L 240,140"
          stroke="#059669" stroke-width="2.5" fill="none"/>
    <g fill="#059669">
      <circle cx="65" cy="320" r="4"/>
      <circle cx="125" cy="260" r="4"/>
      <circle cx="180" cy="185" r="4"/>
      <circle cx="240" cy="140" r="5" stroke="#059669" stroke-width="2" fill="#fff"/>
    </g>
    <text x="68" y="313" font-family="sans-serif" font-size="9" fill="#059669">proposed</text>
    <text x="95" y="248" font-family="sans-serif" font-size="9" fill="#059669">+ adjacent edit</text>
    <text x="155" y="175" font-family="sans-serif" font-size="9" fill="#059669">+ explicit support</text>
    <text x="195" y="130" font-family="sans-serif" font-size="9" fill="#059669" font-weight="600">promoted to task</text>
    <g stroke="#059669" stroke-width="1.5" fill="none">
      <rect x="95" y="375" width="160" height="22" rx="4"/>
    </g>
    <text x="175" y="390" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#059669">task thread created</text>
    <line x1="400" y1="285" x2="650" y2="285" stroke="#dc2626" stroke-width="1" stroke-dasharray="5 3" opacity="0.6"/>
    <text x="646" y="280" text-anchor="end" font-family="sans-serif" font-size="10" fill="#dc2626">noise floor</text>
    <path d="M 415,310 Q 460,295 500,298 Q 540,302 580,307 Q 615,312 640,318"
          stroke="#dc2626" stroke-width="2.5" fill="none"/>
    <circle cx="415" cy="310" r="4" fill="#dc2626"/>
    <text x="418" y="303" font-family="sans-serif" font-size="9" fill="#dc2626">proposed</text>
    <text x="480" y="276" font-family="sans-serif" font-size="10" fill="#dc2626" font-style="italic">no reinforcement arrives</text>
    <g stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3" fill="none" opacity="0.6">
      <rect x="445" y="375" width="160" height="22" rx="4"/>
    </g>
    <text x="525" y="390" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#dc2626" opacity="0.8">quietly evaporates</text>
  </svg>
</p>

The genius of this design, and the reason it's worth borrowing from biology rather than just adding a "suggestions" feature, is that it provides *automatic filtering*. Conventional suggestion boxes fill with noise: every idea anyone has ever had gets recorded, and nobody has the energy to triage them, so the whole system becomes untrustworthy. The foraging mechanism makes triage happen by default — a proposal nobody reinforces vanishes on its own, while a proposal that multiple agents independently find important rises naturally to attention. The database never grows unboundedly with stale ideas, and the proposals that do survive have, by definition, earned the collective attention that justifies them becoming real work.

The technical implementation lives in `packages/core/src/proposal-system.ts`, with two tables (`proposals` and `proposal_reinforcements`) and a half-life around one hour for reinforcements — longer than the ten-minute half-life for pheromones on files, because ideas deserve a longer grace period than edits. A proposal starts with the proposer's own explicit reinforcement, so it's not born at zero strength, and it crosses the promotion threshold when total reinforcement weight (decayed to the present moment) exceeds 2.5. That threshold corresponds roughly to "explicit support from one agent plus either another explicit support or repeated adjacency reinforcement," which is the minimum evidence that the proposal genuinely resonates beyond its original proposer.

### Mechanism three: response thresholds

The third mechanism addresses a problem that shows up once you have more than two agents: how does work get routed to whichever agent is best suited to do it? The ant version of this is called *response threshold allocation*, and it's how colonies decide which castes respond to which stimuli. Soldier ants have a low threshold for "intruder" signals and a high threshold for "hungry larva" signals, so they ignore larva-feeding work unless it becomes a colony-level crisis. Nurse ants have the opposite profile. The colony therefore routes work correctly without any ant directing any other ant — each ant simply asks "is this signal strong enough for *me* personally to care?" and the answers, taken collectively, produce intelligent allocation.

For AI agents, the equivalent is that different models have different strengths. Claude might be better at UI and prose work; Codex might be better at API endpoints and systems code. When a handoff is posted with `to_agent: 'any'`, rather than being claimed by whoever reads the preface first, cavemem can score the handoff against each candidate agent's capability profile and recommend the best fit. The receiving agents still have to *choose* to accept — nothing is automatic, because the agent always has better context about its immediate situation than any routing algorithm does — but the preface each agent sees is tailored to that agent's profile, so the best-fit agent sees the handoff framed as "this is a strong match for you" while a worse-fit agent sees it framed as "this is available but Codex is probably a better fit."

<p align="center">
  <svg viewBox="0 0 700 380" xmlns="http://www.w3.org/2000/svg" role="img" width="100%" style="max-width: 700px">
    <title>Response thresholds: same stimulus, different agents, different responses</title>
    <desc>A handoff request arrives and is scored against the capability profiles of Claude and Codex. Each agent computes a different score, and the preface shown to each agent emphasizes the best match.</desc>
    <text x="350" y="28" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#374151">
      Response-threshold routing: same handoff, different fit scores
    </text>
    <g stroke="#d97706" stroke-width="2" fill="none">
      <rect x="240" y="55" width="220" height="70" rx="8"/>
      <text x="350" y="78" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#d97706" stroke="none">Handoff arrives</text>
      <text x="350" y="96" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#d97706" stroke="none">"fix the /api/exports endpoint,"</text>
      <text x="350" y="112" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#d97706" stroke="none">"add route tests"</text>
    </g>
    <g stroke="#6b7280" stroke-width="1.5" fill="none">
      <path d="M 300,125 L 150,180"/>
      <path d="M 400,125 L 550,180"/>
      <polygon points="150,180 158,172 158,185" fill="#6b7280"/>
      <polygon points="550,180 542,172 542,185" fill="#6b7280"/>
    </g>
    <g stroke="#3b82f6" stroke-width="2" fill="none">
      <rect x="50" y="185" width="200" height="120" rx="8"/>
      <text x="150" y="210" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#3b82f6" stroke="none">Claude profile</text>
    </g>
    <g font-family="sans-serif" font-size="11" fill="#3b82f6">
      <text x="65" y="232">ui_work</text><rect x="130" y="224" width="72" height="10" fill="#3b82f6" opacity="0.7"/><text x="235" y="232" text-anchor="end">0.9</text>
      <text x="65" y="248">api_work</text><rect x="130" y="240" width="32" height="10" fill="#3b82f6" opacity="0.7"/><text x="235" y="248" text-anchor="end">0.4</text>
      <text x="65" y="264">test_work</text><rect x="130" y="256" width="48" height="10" fill="#3b82f6" opacity="0.7"/><text x="235" y="264" text-anchor="end">0.6</text>
      <text x="65" y="280">doc_work</text><rect x="130" y="272" width="64" height="10" fill="#3b82f6" opacity="0.7"/><text x="235" y="280" text-anchor="end">0.8</text>
    </g>
    <text x="150" y="300" text-anchor="middle" font-family="sans-serif" font-size="11" font-style="italic" fill="#6b7280">score: 0.4 + 0.6 = 1.0</text>
    <g stroke="#3b82f6" stroke-width="2" fill="none">
      <rect x="450" y="185" width="200" height="120" rx="8"/>
      <text x="550" y="210" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#3b82f6" stroke="none">Codex profile</text>
    </g>
    <g font-family="sans-serif" font-size="11" fill="#3b82f6">
      <text x="465" y="232">ui_work</text><rect x="530" y="224" width="36" height="10" fill="#3b82f6" opacity="0.7"/><text x="635" y="232" text-anchor="end">0.45</text>
      <text x="465" y="248">api_work</text><rect x="530" y="240" width="80" height="10" fill="#3b82f6" opacity="0.7"/><text x="635" y="248" text-anchor="end">1.0</text>
      <text x="465" y="264">test_work</text><rect x="530" y="256" width="72" height="10" fill="#3b82f6" opacity="0.7"/><text x="635" y="264" text-anchor="end">0.9</text>
      <text x="465" y="280">doc_work</text><rect x="530" y="272" width="28" height="10" fill="#3b82f6" opacity="0.7"/><text x="635" y="280" text-anchor="end">0.35</text>
    </g>
    <text x="550" y="300" text-anchor="middle" font-family="sans-serif" font-size="11" font-style="italic" fill="#059669" font-weight="600">score: 1.0 + 0.9 = 1.9 ✓</text>
    <g stroke="#059669" stroke-width="2" fill="none">
      <rect x="200" y="330" width="300" height="40" rx="8"/>
    </g>
    <text x="350" y="356" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#059669">
      Preface suggests: "Codex is best fit (1.9 vs 1.0)"
    </text>
  </svg>
</p>

The scoring itself is deliberately primitive — a weighted keyword match rather than anything fancier — because the right sophistication level for this layer depends on observing real handoff misrouting, not on imagining it in advance. The `rankCandidates` function in `packages/core/src/response-thresholds.ts` takes a handoff's summary and next-steps text, looks for category keywords (`api`, `endpoint`, `test`, `ui`, etc.), weights them by each candidate agent's profile score for that category, and returns a ranked list. A handoff about "fix the broken viewer component" scores high for an agent with high `ui_work` affinity; a handoff about "update the CI deploy pipeline" scores high for one with high `infra_work`. Ambiguous handoffs produce roughly-equal scores, which is the right failure mode: ambiguity in the handoff means any agent could reasonably take it, and the system correctly refuses to force a preference.

## How the three mechanisms fit together

Each mechanism addresses a specific coordination failure mode, and they compose without any of them needing to know about the others. Pheromones prevent file-edit conflicts by making ambient activity visible. Proposals generate a steady stream of well-filtered work that the colony can tackle between human-initiated tasks. Response thresholds route handoffs to whichever agent is best suited. Take any one away and the system is still functional; combine all three and you get coordination behavior that individual agents never had to be programmed to produce.

A typical working session looks like this in practice. You open Claude Code in one terminal and Codex in another, both `cd`'d into the same branch. Auto-join (keyed on `repo_root + branch`) lands both sessions on the same task thread. Each session's `SessionStart` hook injects a preface telling that agent who else is on the task and what they've recently been doing, drawing on the pheromone heat map and the task timeline. As each agent edits files, `PostToolUse` deposits pheromones, which influence the conflict warnings the other agent will see on its next turn. If either agent notices an improvement worth making later, it files a proposal — weak on its own, but if the other agent later edits a file the proposal would touch, or if a subsequent session independently proposes something similar, the reinforcement accumulates and the proposal eventually becomes its own task. When an agent finishes a chunk of work and wants to hand off, the response-threshold scoring suggests the best recipient. And underneath all of it, cavemem's memory layer is recording everything — compressed observations, embeddings for semantic search, session timelines — so that tomorrow's sessions inherit today's context.

## Getting started

Install cavemem globally with a single command, which downloads the CLI, the bundled MCP server, the embedding worker, and the hook stubs: `npm install -g cavemem`. Register the hooks and MCP server with whichever IDE you use by running `cavemem install --ide claude-code` (or `--ide codex`, `--ide cursor`, etc.). The installer writes the necessary entries into the IDE's settings file and verifies the wiring. You can then confirm everything is connected by running `cavemem status`, which shows the database path, embedding backfill progress, and any currently-installed IDE integrations. If you want to see what's happening in real time while you work, run `cavemem observe` in a spare terminal — it's a live-updating dashboard showing active task threads, current pheromone heat map, pending handoffs, and recent activity from all sessions.

The two commands worth knowing for day-to-day use are `cavemem search <query>` (fast semantic search across all past sessions, useful when you remember discussing something but not which session) and `cavemem viewer` (opens a local web UI at `127.0.0.1:37777` showing session timelines, Hivemind runtime state, and eventually task-thread views). Everything else is meant to happen automatically through the hooks — you shouldn't have to call `task_post` or `task_claim_file` manually, and if you find yourself wanting to, that's feedback worth reporting, because the goal is for coordination to happen by default rather than requiring the human to orchestrate it.

## Current status and roadmap

The memory layer is fully shipped and stable. Compression, FTS, semantic search, session persistence, cross-IDE hook integration, and the MCP server surface with all fourteen tools are all in place and tested. The task-thread collaboration layer is shipped through version 0.2 — auto-join, task messages, file claims, the full handoff lifecycle with atomic claim transfer, and end-to-end hook injection on both `SessionStart` and `UserPromptSubmit`. What's not yet shipped, as of this writing, is the full ant-inspired layer described above. The pheromone system is designed and partially prototyped but not yet integrated into `PostToolUse`. The proposal foraging system is designed but not yet implemented. Response-threshold routing exists as a specification rather than running code.

The honest reason for the gap between design and implementation is that each of these mechanisms deserves to be tuned against real usage data rather than against imagined usage. The pheromone half-life, the proposal promotion threshold, the response-threshold scoring weights — all of these have defaults that are educated guesses, and the right way to find the correct values is to run the system on actual two-agent work for a few days and watch what happens. That observation phase is the current focus, and the code will ship in waves as each mechanism's parameters get validated against what the `cavemem debrief` command reveals at the end of each day.

If you want to contribute, the highest-leverage thing right now is running the system seriously on a real codebase and reporting back on what you observe — particularly the places where coordination feels clumsy, where agents repeatedly step on each other, or where a handoff goes to the wrong agent. Those observations are what the next round of design decisions rest on, and no amount of theoretical work substitutes for real friction reports from real sessions.

## A closing thought on design philosophy

The reason cavemem is built around biological metaphors rather than around conventional distributed-systems primitives is that the problems an agent collective faces — partial information, graceful degradation, persistent work, asynchronous participation — are problems biology has already solved elegantly. Borrowing the solutions isn't just aesthetically pleasing; it's a shortcut to robustness that would take decades to derive from first principles. Ant colonies don't have deadlocks, don't have stale locks, don't have coordinator bottlenecks, and don't collapse when one ant goes quiet, because their coordination mechanism was never built around any of those failure modes in the first place.

What makes this approach work in software, and what's worth understanding if you want to extend cavemem, is that the biological metaphor is not decorative — it's functional. `strengthAt(deposit, time)` is not "inspired by" exponential decay, it *is* exponential decay, the same formula that describes real pheromone evaporation on real surfaces. The proposal foraging algorithm is not "inspired by" ant colony optimization, it *is* ant colony optimization, the same mathematical pattern computer scientists borrowed from biology in the 1990s. When you read cavemem's code, you're reading an implementation of mechanisms that evolution already proved robust. That's a load-bearing claim, not a poetic one, and it's why this particular metaphor earned its place in the architecture rather than just the documentation.

Build the system, watch how it behaves, trust what the biology has already worked out for you, and tune the parameters only where real usage insists. That's the cavemem way, and it turns out to be a surprisingly humble approach: instead of believing your design intuitions are sufficient, you lean on a few hundred million years of accumulated design wisdom, and you treat your own role as figuring out how to port those designs into a new substrate rather than inventing new designs from scratch. Ants, as it happens, make excellent engineering mentors.

---

**License:** MIT
**Author:** Julius Brussee
**Repository:** [github.com/JuliusBrussee/cavemem](https://github.com/JuliusBrussee/cavemem)
