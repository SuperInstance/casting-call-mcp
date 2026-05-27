"""Cast call — defining work requirements for model selection."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class CastCall:
    """A work requirement that needs a model casting decision.

    Describes what kind of task needs to be done, with optional constraints
    on the model, temperature, prompt style, etc.
    """

    task_description: str
    task_type: str = ""
    required_capabilities: list[str] = field(default_factory=list)
    preferred_model: str | None = None
    max_temperature: float | None = None
    min_temperature: float | None = None
    prompt_prefix: str = ""
    context_window: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.task_type:
            # Derive task type from description keywords
            self.task_type = self._infer_task_type()

    def _infer_task_type(self) -> str:
        """Simple keyword-based task type inference."""
        desc = self.task_description.lower()
        type_hints: dict[str, list[str]] = {
            "code_generation": ["code", "implement", "function", "class", "module", "program"],
            "code_review": ["review", "audit", "refactor", "fix bug"],
            "creative_writing": ["story", "poem", "creative", "write", "narrative"],
            "analysis": ["analyze", "analysis", "evaluate", "assess", "investigate"],
            "summarization": ["summarize", "summary", "tldr", "digest"],
            "translation": ["translate", "translation", "localize"],
            "reasoning": ["reason", "logic", "prove", "math", "calculate", "solve"],
            "planning": ["plan", "strategy", "roadmap", "schedule", "organize"],
            "debugging": ["debug", "error", "traceback", "exception", "stack trace"],
            "documentation": ["document", "docs", "readme", "explain", "describe"],
        }
        for task_type, keywords in type_hints.items():
            if any(kw in desc for kw in keywords):
                return task_type
        return "general"

    def matches_evaluation(self, evaluation: dict[str, Any]) -> float:
        """Score how well an evaluation matches this cast call (0.0–1.0)."""
        score = 0.0

        # Task type match
        if evaluation.get("task_type") == self.task_type:
            score += 0.4
        elif self.task_type and evaluation.get("task_type", "").startswith(self.task_type.split("_")[0]):
            score += 0.2

        # Keyword overlap
        desc_words = set(self.task_description.lower().split())
        eval_words = set(evaluation.get("task_type", "").lower().replace("_", " ").split())
        if desc_words and eval_words:
            overlap = len(desc_words & eval_words) / max(len(desc_words | eval_words), 1)
            score += overlap * 0.3

        # Quality bonus
        quality = evaluation.get("quality", 3)
        score += (quality / 5.0) * 0.2

        # Success bonus
        if evaluation.get("success"):
            score += 0.1

        return min(score, 1.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_description": self.task_description,
            "task_type": self.task_type,
            "required_capabilities": self.required_capabilities,
            "preferred_model": self.preferred_model,
            "max_temperature": self.max_temperature,
            "min_temperature": self.min_temperature,
            "prompt_prefix": self.prompt_prefix,
            "context_window": self.context_window,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CastCall:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
