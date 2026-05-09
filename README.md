# Casting-Call MCP ⚓

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

#### `cast_model(task_description)` — Get the best model for a task

```json
{
  "tool": "cast_model",
  "arguments": {
    "task_description": "I need to write a 500-line Rust constraint solver with formal verification"
  }
}
```

**Response:**
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
    "notes": "Completed in one pass. No truncation at 500 lines."
  }
}
```

Every logged result improves future recommendations. The database grows organically.

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
│   └── index.mjs        — MCP server + CLI entrypoint
├── data/
│   └── cast-log.json    — Evaluation database (grows with usage)
├── package.json
├── README.md
├── .env.example         — API keys for model evaluation (optional)
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
3. Commit and push — the fleet learns from every voyage

Standing orders:
- **Evidence, not vibes.** Exact scores, token counts, truncation rates.
- **Date everything.** Models change. What held in May may not in June.
- **Note the task type.** A model that can't write code might be the best prose editor.

---

## License

MIT

---

*Fair winds. Bring back what you find.*
