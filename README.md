# Casting-Call MCP ⚓


## Meta

**Domain:** other
**Depends on:** —
**Depended by:** —
**Implements:** MCP server: consultative database for model casting decisions — choose the right...
**Related:** —


**A consultative database that agents use to choose the right model for the right task.**

Every voyage needs different hands. This MCP server tells you who to board, at what temperature, and with what prompt prefix — backed by real evaluation data that grows with every task.

```
{task} ──→ casting-call-mcp ──→ { recommended_model, temperature, prompt_prefix }
                                        ↑
                                   cast-log.json
                                 (historical data)
```

---

## Installation

```bash
git clone https://github.com/SuperInstance/casting-call-mcp.git
cd casting-call-mcp
npm install
```

### Quick Start — MCP Server

```bash
# Start the MCP server (stdio transport — connect via any MCP client)
node src/index.mjs

# Or use the CLI directly
node src/index.mjs query "rust constraint solver"
node src/index.mjs stats
```

### Integration with Claude Code

Add to your `claude.json`:
```json
{
  "mcpServers": {
    "casting-call": {
      "command": "node",
      "args": ["/path/to/casting-call-mcp/src/index.mjs"]
    }
  }
}
```

### Integration with OpenClaw

Add to your OpenClaw MCP config:
```yaml
mcpServers:
  casting-call:
    command: node
    args: [/path/to/casting-call-mcp/src/index.mjs]
```

---

## Usage

### For Agents (via MCP)

#### `cast_model(task_description, trust_weighted?)` — Get the best model for a task

```json
{
  "tool": "cast_model",
  "arguments": {
    "task_description": "I need to write a 500-line Rust constraint solver with formal verification",
    "trust_weighted": false
  }
}
```

With `trust_weighted: true`, the response includes trust-weighted rankings
that account for contributor trust scores.

**Response (standard):**
```json
{
  "recommended_model": "deepseek/deepseek-v4-flash",
  "confidence": 0.82,
  "prompt_prefix": "Write production-quality Rust code. Focus on correctness and type safety.",
  "temperature": 0.3,
  "max_tokens": 4000,
  "fallback": "claude-sonnet-4",
  "model_stats": [
    { "model": "deepseek/deepseek-v4-flash", "avgQuality": 4.2, "successRate": 0.85, "observations": 12 }
  ],
  "warnings": {
    "deepseek/deepseek-v4-flash": {
      "subagent_truncation_rate": 0.3,
      "note": "~30% of subagent tasks truncate. Over-spawn by 30%."
    }
  }
}
```

**Response (trust-weighted, includes `trust_ranked`):**
```json
{
  "recommended_model": "deepseek/deepseek-v4-flash",
  "confidence": 0.85,
  "trust_weighted": true,
  "prompt_prefix": "Write production-quality Rust code. Focus on correctness and type safety.",
  "temperature": 0.3,
  "max_tokens": 4000,
  "fallback": "claude-sonnet-4",
  "model_stats": [ ... ],
  "trust_ranked": [
    {
      "model": "deepseek/deepseek-v4-flash",
      "weighted_quality": 4.52,
      "evaluation_count": 12,
      "source_diversity": 3,
      "top_contributors": ["oracle1@fleet", "forgemaster@fleet"]
    }
  ],
  "warnings": { ... }
}
```

#### `log_result(...)` — Log what happened after completing a task

```json
{
  "tool": "log_result",
  "arguments": {
    "model": "deepseek/deepseek-v4-flash",
    "task_type": "rust_constraint_solver",
    "task_length": 500,
    "success": true,
    "quality": 4,
    "truncated": false,
    "notes": "Completed in one pass. No truncation at 500 lines.",
    "contributor": "oracle1@fleet"
  }
}
```

The `contributor` field auto-fills from `git config user.name` / `user.email`.
Override it by passing explicitly.

Every logged result automatically:
1. Syncs with fleet (pulls latest evaluations)
2. Merges local + fleet evaluations
3. Pushes back to `origin/main`

The database grows organically across all fleet members.

#### `evaluate_models(...)` — Run a comparison across models

```json
{
  "tool": "evaluate_models",
  "arguments": {
    "task_type": "narrative_critique",
    "task_length": 180,
    "results": [
      { "model": "bytedance/seed-2.0-mini", "quality": 4, "success": true, "notes": "Emotionally varied phrasings" },
      { "model": "nvidia/nemotron-3-nano-30b-a3b-reasoning", "quality": 2, "success": false, "notes": "Hallucinated source text" },
      { "model": "zai/glm-5.1", "quality": 5, "success": true, "notes": "Precise structural analysis" }
    ]
  }
}
```

#### `signature(text)` — Analyze text for anchor-point signature

Returns structural metrics: word count, sentence length, lexical diversity, opening strategy, negative space usage.

#### `get_stats()` — Database statistics

See how many evaluations have been logged, per-model stats, and known warnings.

### For Humans (via CLI)

```bash
# Query
./src/index.mjs query "rust constraint solver"

# Log a result (interactive)
./src/index.mjs log

# Add a template (interactive)
./src/index.mjs add

# Show stats
./src/index.mjs stats

# Help
./src/index.mjs help
```

---

## The Database

Everything lives in a single JSON file: `data/cast-log.json`.

```json
{
  "evaluations": [
    {
      "model": "deepseek/deepseek-v4-flash",
      "task_type": "rust_constraint_solver",
      "task_length": 500,
      "success": true,
      "quality": 4,
      "truncated": false,
      "tokens_used": 12000,
      "date": "2026-05-09"
    }
  ],
  "task_templates": {
    "rust_code": {
      "recommended_model": "deepseek/deepseek-v4-flash",
      "prompt_prefix": "Write production-quality Rust code. Focus on correctness and type safety.",
      "temperature": 0.3,
      "fallbacks": ["claude-sonnet-4", "zai/glm-5.1"]
    }
  },
  "warnings": {
    "deepseek/deepseek-v4-flash": {
      "subagent_truncation_rate": 0.3,
      "note": "~30% of subagent tasks truncate. Over-spawn by 30%."
    }
  }
}
```

### Pre-populated Data

The database ships with 56 evaluations collected from real usage across:
- **Code generation** — Rust, web, tools
- **Creative writing** — narrative, voice, tone
- **Research** — factual verification, URL checking
- **Role-play** — reverse-actualization, play-testing
- **Critique** — structural editing, voice analysis

And 9 task templates covering common patterns:
- `rust_code`, `creative_writing`, `structural_editing`, `voice_critique`
- `code_review`, `research_factual`, `creative_synthesis`
- `proof_formal`, `reverse_actualization`

---

## Known Warnings (Built-in)

| Model | Risk | Mitigation |
|-------|------|-----------|
| DeepSeek v4-flash | ~30% subagent truncation | Over-spawn by 30% |
| GLM-5.1 | `reasoning_content` field bug | Use Anthropic-compatible path |
| Nemotron-3-Nano | Hallucinates source text | Only use for style tests |
| Seed-2.0-mini | ~25% timeout rate | Always have retry logic |

---

---

## Federation via Git

Casting-Call can sync evaluations across the fleet via git. Every user runs their
own local copy, but the shared `origin/main` branch keeps everyone in sync.

### How It Works

```
  Your machine                        Fleet (origin/main)
  ┌─────────────────────┐             ┌─────────────────────┐
  │ cast-log.json       │───push──→   │ cast-log.json       │
  │ trust.json          │             │ trust.json          │
  ├─────────────────────┤             ├─────────────────────┤
  │ git pull ←─────────│  ←──pull──  │ (other people's     │
  │ auto-merge          │             │  evaluations)       │
  └─────────────────────┘             └─────────────────────┘
```

### Setup

Every contributor needs to configure git with their fleet identity:

```bash
git config user.name "oracle1"
git config user.email "oracle1@fleet"
```

That's it. The federation layer reads these values automatically.

### What Happens on `log_result`

1. **Pull** — Latest fleet evaluations are pulled from `origin/main`
2. **Merge** — Fleet and local evaluations are merged (local wins for exact match)
3. **Save** — Merged database is saved to disk
4. **Commit** — Changes are committed with a descriptive message
5. **Push** — Changes are pushed to `origin/main` (best-effort)

### What Happens on `cast_model`

1. **Pull** — Latest fleet evaluations are pulled
2. **Compute** — Best model is found using merged data
3. **Return** — Result includes model stats and (optionally) trust-weighted rankings

### Conflict Resolution

If two contributors evaluate the same model on the same task type differently,
**both evaluations are kept**. The trust system handles weighting — more data is
always better.

### CLI Commands

```bash
# Force sync with fleet
casting-call-mcp sync
```

### Network Failures

All federation operations are best-effort. If git is unavailable (no network,
no origin configured), the local database works fine. Changes sync on the
next successful connection.

The trust system works entirely locally even without federation.

---

## Trust System

The trust system lets contributors weight recommendations based on who they
trust. A contributor with high trust scores has more influence on model
recommendations than one with low trust.

### Trust Model

Every contributor has:
- **global_trust** (default: 0.5) — Baseline trust score 0.0–1.0
- **task_trust** — Optional per-task-type overrides

New contributors (no trust entry) are assigned `default_trust` (0.5).

### How Trust Affects Recommendations

When `--trust-weighted` mode is active, the matching engine:

1. Groups evaluations by model
2. Weights each evaluation by the contributor's trust score
3. Computes a weighted average quality per model
4. Ranks models by weighted quality
5. Reports source diversity (how many distinct contributors evaluated each model)

This means a highly-trusted contributor's 5/5 rating carries more weight than
an untrusted contributor's 5/5 rating.

### CLI Commands

```bash
# List all known contributors with their trust scores
casting-call-mcp trust list

# Set global trust for a contributor
casting-call-mcp trust set --contributor "oracle1@fleet" --global 0.85

# Set per-task trust override
casting-call-mcp trust set --contributor "forgemaster@fleet" --task "rust_code" --score 1.0
```

### Trust-Weighted Query

```bash
# Standard query
casting-call-mcp query "rust constraint solver"

# Trust-weighted query (includes weighted rankings)
casting-call-mcp query "rust constraint solver" --trust
```

### Trust Database

Trust settings are stored in `data/trust.json`:

```json
{
  "version": 1,
  "default_trust": 0.5,
  "task_defaults": {
    "rust_code": { "untrusted_weight": 0.3 },
    "creative_writing": { "untrusted_weight": 0.4 }
  },
  "contributors": {
    "oracle1@fleet": {
      "global_trust": 0.85,
      "task_trust": {
        "rust_code": 1.0,
        "creative_writing": 0.3
      },
      "source": "git-author",
      "notes": "Night shift operator"
    }
  }
}
```

### Updating Existing Data

If you're adding this to an existing database, backfill contributor fields:

```bash
casting-call-mcp update-templates
```

This adds `contributor: "oracle1@fleet"` to all evaluations that don't have one.

---

## How It Works

```
Agent: "I need to write a constraint solver"
         │
         ▼
   cast_model(task_description)
         │
         ▼
   Matching Engine
   ├─ Compare against task_templates (keyword + length similarity)
   ├─ Query historical evaluations for same task type
   └─ Compute confidence from similarity + evaluation volume
         │
         ▼
   Returns: { recommended_model, prompt_prefix, temp, warnings }
         │
         ▼
Agent runs task → logs result → database grows → next query is smarter
```

---

## File Structure

```
casting-call-mcp/
├── src/
│   ├── index.mjs         — MCP server + CLI entrypoint
│   ├── trust.mjs         — Trust manager (weighted recommendations)
│   └── federation.mjs    — Federation via git (sync, merge, push)
├── data/
│   ├── cast-log.json     — Evaluation database (grows with usage)
│   └── trust.json        — Trust scores for contributors
├── package.json
├── README.md
├── .env.example          — API keys for model evaluation (optional)
└── .gitignore
```

---

## Model Naming Convention

Use fully-qualified model identifiers:

| Format | Example |
|--------|---------|
| `provider/model-name` | `deepseek/deepseek-v4-flash` |
| `huggingface/model-id` | `nousresearch/hermes-3-llama-3.1-405b` |
| `provider/model-name` | `zai/glm-5.1` |
| `platform/model-alias` | `bytedance/seed-2.0-mini` |

---

## Contributing

Every evaluation improves the database. When you complete a task with a model:

1. Run `log_result` via the MCP tool
2. Include: model, task type, success, quality (1-5), any notes
3. Your git identity is automatically attached as the contributor
4. The evaluation is committed and pushed to the fleet automatically

The fleet learns from every voyage, every contributor.

### Setting Up as a New Contributor

1. Clone the repo
2. Set your git identity: `git config user.name "your-name"` and `git config user.email "your-email@fleet"`
3. The federation layer will handle the rest
4. To set trust for yourself or others: see the Trust System section above

### Standing Orders

- **Evidence, not vibes.** Exact scores, token counts, truncation rates.
- **Date everything.** Models change. What held in May may not in June.
- **Note the task type.** A model that can't write code might be the best prose editor.
- **Your identity matters.** Tagged evaluations let the trust system weight your contributions.

---

## License

MIT

---

*Fair winds. Bring back what you find.*

---

## Python Package

The `casting_call_mcp` Python package provides a native implementation of the casting-call system with no external dependencies beyond `pytest` for testing.

### Installation

```bash
pip install -e .
# or with dev dependencies:
pip install -e ".[dev]"
```

### Quick Start

```python
from casting_call_mcp import MCPServer
from casting_call_mcp.cast import CastCall
from casting_call_mcp.role import Actor, Role, ModelCapability
from casting_call_mcp.audition import Audition
from casting_call_mcp.schedule import ScheduleManager, TaskPriority

# Query for the best model
server = MCPServer()
result = server.call_tool("cast_model", {"task_description": "implement a sorting algorithm"})
print(result["recommended_model"])  # e.g., "GPT-4"

# Log a result
server.call_tool("log_result", {
    "model": "GPT-4",
    "task_type": "code_generation",
    "success": True,
    "quality": 5,
})

# Run an audition	rust_weights = {"alice": 1.0, "bob": 0.5}
audition = Audition(evaluations, trust_weights=trust_weights)
report = audition.run(task_type="code_generation")
print(report.winner.candidate_name)  # Best model

# Schedule tasks
sm = ScheduleManager(max_concurrent_per_model=3)
task = sm.schedule("code_review", "Claude", priority=TaskPriority.HIGH)
```

### Architecture

| Module | Purpose |
|---|---|
| `server.py` | MCP server with tool definitions for model casting |
| `cast.py` | `CastCall` — define work requirements and match evaluations |
| `role.py` | `Actor` / `Role` — match models to capabilities |
| `audition.py` | `Audition` — score and rank candidates with trust weighting |
| `schedule.py` | `ScheduleManager` — workload scheduling with conflict resolution |

### Running Tests

```bash
python3 -m pytest tests/ -q
```
