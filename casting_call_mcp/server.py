"""MCP Server — Model Context Protocol server for workload casting."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .audition import Audition
from .cast import CastCall
from .role import Actor, ModelCapability, Role
from .schedule import ScheduleManager, TaskPriority


# ── Database ──────────────────────────────────────────────────────────────

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load_database(path: Path | str | None = None) -> dict[str, Any]:
    """Load the cast-log.json database."""
    path = Path(path) if path else DEFAULT_DATA_DIR / "cast-log.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"evaluations": [], "task_templates": {}, "warnings": {}}


def save_database(db: dict[str, Any], path: Path | str | None = None) -> None:
    """Save the database to disk."""
    path = Path(path) if path else DEFAULT_DATA_DIR / "cast-log.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(db, indent=2) + "\n", encoding="utf-8")


def load_trust_db(path: Path | str | None = None) -> dict[str, Any]:
    """Load the trust.json database."""
    path = Path(path) if path else DEFAULT_DATA_DIR / "trust.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": 1, "default_trust": 0.5, "task_defaults": {}, "contributors": {}}


# ── MCP Tool Definitions ──────────────────────────────────────────────────

MCP_TOOLS = [
    {
        "name": "cast_model",
        "description": "Query the database for the best model match for a task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_description": {"type": "string", "description": "Describe the task"},
                "trust_weighted": {"type": "boolean", "default": False},
            },
            "required": ["task_description"],
        },
    },
    {
        "name": "log_result",
        "description": "Log an evaluation result for a model on a task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "task_type": {"type": "string"},
                "success": {"type": "boolean"},
                "quality": {"type": "number", "minimum": 1, "maximum": 5},
                "notes": {"type": "string"},
                "contributor": {"type": "string"},
            },
            "required": ["model", "task_type", "success", "quality"],
        },
    },
    {
        "name": "get_stats",
        "description": "Get evaluation statistics across all models.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_templates",
        "description": "List all task templates with recommended models.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "audition_models",
        "description": "Run an audition to rank models for a specific task type.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_type": {"type": "string"},
                "task_description": {"type": "string"},
            },
        },
    },
    {
        "name": "schedule_task",
        "description": "Schedule a task for a model with conflict resolution.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_type": {"type": "string"},
                "model": {"type": "string"},
                "priority": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]},
            },
            "required": ["task_type", "model"],
        },
    },
]


@dataclass
class MCPServer:
    """Casting-Call MCP Server.

    Provides tool definitions for MCP clients to query model recommendations,
    log results, run auditions, and manage task scheduling.
    """

    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)
    db: dict[str, Any] = field(default_factory=dict)
    trust_db: dict[str, Any] = field(default_factory=dict)
    schedule_manager: ScheduleManager = field(default_factory=ScheduleManager)

    def __post_init__(self) -> None:
        self.db = load_database(self.data_dir / "cast-log.json")
        self.trust_db = load_trust_db(self.data_dir / "trust.json")

    def reload(self) -> None:
        """Reload databases from disk."""
        self.db = load_database(self.data_dir / "cast-log.json")
        self.trust_db = load_trust_db(self.data_dir / "trust.json")

    # ── Tool Handlers ──────────────────────────────────────────────────

    def list_tools(self) -> list[dict[str, Any]]:
        """Return MCP tool definitions."""
        return MCP_TOOLS

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Dispatch a tool call by name."""
        handlers = {
            "cast_model": self._handle_cast_model,
            "log_result": self._handle_log_result,
            "get_stats": self._handle_get_stats,
            "list_templates": self._handle_list_templates,
            "audition_models": self._handle_audition,
            "schedule_task": self._handle_schedule_task,
        }
        handler = handlers.get(name)
        if not handler:
            return {"error": f"Unknown tool: {name}"}
        return handler(arguments)

    def _handle_cast_model(self, args: dict[str, Any]) -> dict[str, Any]:
        """Find the best model for a task description."""
        description = args.get("task_description", "")
        trust_weighted = args.get("trust_weighted", False)
        cast = CastCall(task_description=description)

        # Check templates first
        templates = self.db.get("task_templates", {})
        best_template = None
        best_sim = 0.0
        for key, tmpl in templates.items():
            sim = _compute_similarity(description, key)
            if sim > best_sim:
                best_sim = sim
                best_template = tmpl

        # Run audition for trust-weighted scoring
        if trust_weighted:
            trust_weights = {
                c: data.get("global_trust", 0.5)
                for c, data in self.trust_db.get("contributors", {}).items()
            }
            audition = Audition(
                self.db.get("evaluations", []),
                trust_weights=trust_weights,
                default_trust=self.trust_db.get("default_trust", 0.5),
            )
        else:
            audition = Audition(self.db.get("evaluations", []))

        report = audition.run(task_type=cast.task_type, task_description=description)

        result: dict[str, Any] = {
            "task_type": cast.task_type,
            "description": description,
            "template_match": best_template if best_sim > 0.3 else None,
            "template_similarity": round(best_sim, 3),
        }
        if report.winner:
            result["recommended_model"] = report.winner.candidate_name
            result["score"] = report.winner.score
            result["quality_avg"] = round(report.winner.quality_avg, 2)
            result["success_rate"] = round(report.winner.success_rate, 2)
            result["observations"] = report.winner.observation_count
        else:
            result["recommended_model"] = None
            result["note"] = "No matching evaluations found"

        return result

    def _handle_log_result(self, args: dict[str, Any]) -> dict[str, Any]:
        """Log an evaluation result."""
        from datetime import date

        entry = {
            "model": args["model"],
            "task_type": args["task_type"],
            "success": args["success"],
            "quality": args["quality"],
            "notes": args.get("notes", ""),
            "contributor": args.get("contributor", "unknown"),
            "date": args.get("date", date.today().isoformat()),
        }
        self.db.setdefault("evaluations", []).append(entry)
        save_database(self.db, self.data_dir / "cast-log.json")
        return {"status": "logged", "entry": entry}

    def _handle_get_stats(self, _args: dict[str, Any]) -> dict[str, Any]:
        """Return evaluation statistics."""
        evals = self.db.get("evaluations", [])
        by_model: dict[str, dict[str, Any]] = {}
        for e in evals:
            model = e.get("model", "unknown")
            if model not in by_model:
                by_model[model] = {"count": 0, "total_quality": 0.0, "successes": 0}
            by_model[model]["count"] += 1
            by_model[model]["total_quality"] += e.get("quality", 0)
            if e.get("success"):
                by_model[model]["successes"] += 1

        models = []
        for model, stats in by_model.items():
            models.append({
                "model": model,
                "avg_quality": round(stats["total_quality"] / stats["count"], 2),
                "success_rate": round(stats["successes"] / stats["count"], 2),
                "observations": stats["count"],
            })
        models.sort(key=lambda m: m["observations"], reverse=True)

        return {
            "total_evaluations": len(evals),
            "total_templates": len(self.db.get("task_templates", {})),
            "models": models,
        }

    def _handle_list_templates(self, _args: dict[str, Any]) -> dict[str, Any]:
        """List all task templates."""
        templates = self.db.get("task_templates", {})
        return {
            "count": len(templates),
            "templates": [
                {"task_type": k, **v} for k, v in templates.items()
            ],
        }

    def _handle_audition(self, args: dict[str, Any]) -> dict[str, Any]:
        """Run an audition for models."""
        trust_weights = {
            c: data.get("global_trust", 0.5)
            for c, data in self.trust_db.get("contributors", {}).items()
        }
        audition = Audition(
            self.db.get("evaluations", []),
            trust_weights=trust_weights,
            default_trust=self.trust_db.get("default_trust", 0.5),
        )
        report = audition.run(
            task_type=args.get("task_type", ""),
            task_description=args.get("task_description", ""),
        )
        return report.to_dict()

    def _handle_schedule_task(self, args: dict[str, Any]) -> dict[str, Any]:
        """Schedule a task for a model."""
        priority = TaskPriority[args.get("priority", "MEDIUM")]
        task = self.schedule_manager.schedule(
            task_type=args["task_type"],
            model=args["model"],
            priority=priority,
        )
        return task.to_dict()


# ── Helpers ────────────────────────────────────────────────────────────────

def _compute_similarity(a: str, b: str) -> float:
    """Simple keyword overlap similarity between two strings."""
    a_words = set(a.lower().split())
    b_words = set(b.lower().replace("_", " ").split())
    if not a_words or not b_words:
        return 0.0
    overlap = len(a_words & b_words)
    return overlap / max(len(a_words | b_words), 1)
