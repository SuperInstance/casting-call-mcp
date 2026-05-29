# casting-call-mcp — Model Casting Decisions

**A consultative database for AI model casting decisions. Which model for which task? Let the data decide.**

## What This Gives You

- **Role definitions** — define what a task requires (speed, creativity, accuracy, cost)
- **Audition system** — test models against task requirements with scored evaluations
- **Casting decisions** — select the best model for each role based on audition results
- **Schedule management** — plan and track model evaluations
- **MCP server** — expose casting decisions through the Model Context Protocol

## Quick Start

```bash
pip install casting-call-mcp
```

```python
from casting_call_mcp import Role, Audition, CastingDirector

# Define what you need
role = Role(
    name="code-review",
    requirements={"accuracy": 0.9, "speed": 0.7, "cost": 0.3},
)

# Audition models
director = CastingDirector()
director.add_candidate("claude-3.5-sonnet")
director.add_candidate("gpt-4o")
director.add_candidate("deepseek-chat")

results = director.audition(role)
for r in results.ranked:
    print(f"{r.model}: score={r.score:.2f}")

# Cast the best fit
cast = director.cast(role)
print(f"Selected: {cast.model}")
```

## API Reference

### `Role(name, requirements)` — Task requirements as weighted criteria
### `Audition(role, candidates)` — Run evaluations, collect scores
### `CastingDirector` — `add_candidate()`, `audition(role)`, `cast(role)`
### `Schedule` — Plan and track audition sessions
### `MCPServer` — Expose via Model Context Protocol

## How It Fits

The model selection layer for the [SuperInstance fleet](https://github.com/SuperInstance). Ensures the right model handles the right task.

- **[cocapn-sdk](https://github.com/SuperInstance/cocapn-sdk)** — Routes to selected models
- **[casting-call-gpu](https://github.com/SuperInstance/casting-call-gpu)** — GPU-accelerated casting math
- **[Claude-PRISM-CF](https://github.com/SuperInstance/Claude-PRISM-CF)** — Edge model routing

## Testing

```bash
pytest tests/
```

## Installation

```bash
pip install casting-call-mcp
```

Python 3.10+. MIT license.
