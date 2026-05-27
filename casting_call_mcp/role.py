"""Role — matching actors (models) to capabilities for workload casting."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ModelCapability(Enum):
    """Known model capabilities."""

    CODE_GENERATION = "code_generation"
    CODE_REVIEW = "code_review"
    CREATIVE_WRITING = "creative_writing"
    ANALYSIS = "analysis"
    SUMMARIZATION = "summarization"
    TRANSLATION = "translation"
    REASONING = "reasoning"
    PLANNING = "planning"
    DEBUGGING = "debugging"
    DOCUMENTATION = "documentation"
    MULTI_TURN = "multi_turn"
    LONG_CONTEXT = "long_context"
    STRUCTURED_OUTPUT = "structured_output"
    FUNCTION_CALLING = "function_calling"


@dataclass
class Actor:
    """A model that can be cast for tasks.

    Tracks capabilities, performance history, and operational parameters.
    """

    name: str
    capabilities: set[ModelCapability] = field(default_factory=set)
    default_temperature: float = 0.5
    context_window: int | None = None
    prompt_prefix: str = ""
    notes: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def can_perform(self, capability: ModelCapability) -> bool:
        return capability in self.capabilities

    def can_perform_all(self, capabilities: set[ModelCapability]) -> bool:
        return capabilities.issubset(self.capabilities)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "capabilities": [c.value for c in self.capabilities],
            "default_temperature": self.default_temperature,
            "context_window": self.context_window,
            "prompt_prefix": self.prompt_prefix,
            "notes": self.notes,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Actor:
        caps = set()
        for c in data.get("capabilities", []):
            try:
                caps.add(ModelCapability(c) if isinstance(c, str) else c)
            except ValueError:
                pass
        return cls(
            name=data["name"],
            capabilities=caps,
            default_temperature=data.get("default_temperature", 0.5),
            context_window=data.get("context_window"),
            prompt_prefix=data.get("prompt_prefix", ""),
            notes=data.get("notes", ""),
            metadata=data.get("metadata", {}),
        )


@dataclass
class Role:
    """A role requirement that actors can be matched against.

    Describes the capabilities needed, performance expectations,
    and constraints for a particular task.
    """

    name: str
    capabilities: set[ModelCapability] = field(default_factory=set)
    min_quality: float = 3.0
    temperature_range: tuple[float, float] = (0.0, 1.0)
    required_context_window: int | None = None
    preferred_actors: list[str] = field(default_factory=list)
    excluded_actors: list[str] = field(default_factory=list)

    def match_score(self, actor: Actor) -> float:
        """Score how well an actor matches this role (0.0–1.0).

        Considers capability coverage, quality fit, and preferences.
        """
        if actor.name in self.excluded_actors:
            return 0.0

        score = 0.0

        # Capability coverage (most important, 0-0.5)
        if self.capabilities:
            covered = len(self.capabilities & actor.capabilities)
            total = len(self.capabilities)
            score += (covered / total) * 0.5
        else:
            score += 0.25  # No specific requirements, partial credit

        # Temperature range fit (0-0.2)
        if self.temperature_range[0] <= actor.default_temperature <= self.temperature_range[1]:
            score += 0.2

        # Context window (0-0.15)
        if self.required_context_window:
            if actor.context_window and actor.context_window >= self.required_context_window:
                score += 0.15
            elif not actor.context_window:
                score += 0.05  # Unknown, partial credit
        else:
            score += 0.1

        # Preferred actor bonus (0-0.15)
        if actor.name in self.preferred_actors:
            score += 0.15

        return min(score, 1.0)

    def find_best_actor(self, actors: list[Actor]) -> Actor | None:
        """Find the best matching actor from a pool."""
        scored = [(a, self.match_score(a)) for a in actors if a.name not in self.excluded_actors]
        if not scored:
            return None
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[0][0] if scored[0][1] > 0 else None

    def rank_actors(self, actors: list[Actor]) -> list[tuple[Actor, float]]:
        """Rank all actors by match score."""
        scored = [(a, self.match_score(a)) for a in actors if a.name not in self.excluded_actors]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored
