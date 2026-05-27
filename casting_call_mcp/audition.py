"""Audition — scoring and ranking model candidates for tasks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AuditionResult:
    """Result of auditioning a single candidate."""

    candidate_name: str
    score: float
    quality_avg: float
    success_rate: float
    observation_count: int
    trust_weight: float = 1.0
    source_diversity: int = 1
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_name": self.candidate_name,
            "score": round(self.score, 3),
            "quality_avg": round(self.quality_avg, 2),
            "success_rate": round(self.success_rate, 2),
            "observation_count": self.observation_count,
            "trust_weight": round(self.trust_weight, 3),
            "source_diversity": self.source_diversity,
            "notes": self.notes,
        }


@dataclass
class AuditionReport:
    """Full audition report with ranked candidates."""

    task_type: str
    task_description: str
    candidates: list[AuditionResult] = field(default_factory=list)
    winner: AuditionResult | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_type": self.task_type,
            "task_description": self.task_description,
            "winner": self.winner.to_dict() if self.winner else None,
            "candidates": [c.to_dict() for c in self.candidates],
        }


class Audition:
    """Score and rank model candidates based on evaluation history.

    The audition process evaluates each candidate model against historical
    performance data, weighted by contributor trust scores. It produces
    a ranked report with the best candidate selected.
    """

    def __init__(
        self,
        evaluations: list[dict[str, Any]],
        trust_weights: dict[str, float] | None = None,
        default_trust: float = 0.5,
    ) -> None:
        self.evaluations = evaluations
        self.trust_weights = trust_weights or {}
        self.default_trust = default_trust

    def _get_trust(self, contributor: str) -> float:
        return self.trust_weights.get(contributor, self.default_trust)

    def _group_by_model(
        self, evaluations: list[dict[str, Any]] | None = None
    ) -> dict[str, list[dict[str, Any]]]:
        evals = evaluations if evaluations is not None else self.evaluations
        groups: dict[str, list[dict[str, Any]]] = {}
        for e in evals:
            model = e.get("model", "unknown")
            groups.setdefault(model, []).append(e)
        return groups

    def _score_candidate(self, evals: list[dict[str, Any]]) -> AuditionResult:
        """Compute a weighted score for a candidate from its evaluations."""
        if not evals:
            return AuditionResult(
                candidate_name="unknown", score=0.0, quality_avg=0.0,
                success_rate=0.0, observation_count=0,
            )

        name = evals[0].get("model", "unknown")
        weighted_quality = 0.0
        total_weight = 0.0
        success_count = 0
        contributors: set[str] = set()

        for e in evals:
            contributor = e.get("contributor", "unknown")
            trust = self._get_trust(contributor)
            quality = e.get("quality", 3)
            weighted_quality += quality * trust
            total_weight += trust
            if e.get("success", False):
                success_count += 1
            contributors.add(contributor)

        avg_quality = weighted_quality / total_weight if total_weight > 0 else 0.0
        success_rate = success_count / len(evals) if evals else 0.0

        # Composite score: weighted quality (60%) + success rate (30%) + diversity bonus (10%)
        diversity_bonus = min(len(contributors) / 5.0, 1.0)  # Cap at 5 contributors
        composite = (avg_quality / 5.0) * 0.6 + success_rate * 0.3 + diversity_bonus * 0.1

        return AuditionResult(
            candidate_name=name,
            score=composite,
            quality_avg=avg_quality / total_weight * len(evals) if total_weight > 0 else 0.0,
            success_rate=success_rate,
            observation_count=len(evals),
            trust_weight=total_weight,
            source_diversity=len(contributors),
        )

    def run(
        self,
        task_type: str = "",
        task_description: str = "",
        evaluations: list[dict[str, Any]] | None = None,
    ) -> AuditionReport:
        """Run an audition for all candidates and return a ranked report."""
        evals = evaluations if evaluations is not None else self.evaluations

        # Filter by task type if specified
        if task_type:
            filtered = [e for e in evals if task_type in e.get("task_type", "")]
        else:
            filtered = evals

        if not filtered:
            return AuditionReport(
                task_type=task_type,
                task_description=task_description,
            )

        # Score each candidate
        grouped = self._group_by_model(filtered)
        results = []
        for _model, model_evals in grouped.items():
            result = self._score_candidate(model_evals)
            results.append(result)

        # Rank by score descending
        results.sort(key=lambda r: r.score, reverse=True)

        return AuditionReport(
            task_type=task_type,
            task_description=task_description,
            candidates=results,
            winner=results[0] if results else None,
        )

    @staticmethod
    def from_database(db: dict[str, Any], trust_weights: dict[str, float] | None = None) -> Audition:
        """Create an Audition from a cast-log database."""
        return Audition(
            evaluations=db.get("evaluations", []),
            trust_weights=trust_weights,
            default_trust=db.get("default_trust", 0.5),
        )
