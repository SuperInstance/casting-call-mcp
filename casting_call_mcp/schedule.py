"""Schedule manager — conflict resolution for model workload scheduling."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any


class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4


class TaskStatus(Enum):
    PENDING = "pending"
    SCHEDULED = "scheduled"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class ScheduledTask:
    """A task scheduled against a model with timing and status."""

    task_id: str
    task_type: str
    model: str
    priority: TaskPriority = TaskPriority.MEDIUM
    status: TaskStatus = TaskStatus.PENDING
    scheduled_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    estimated_duration: timedelta = field(default_factory=lambda: timedelta(minutes=5))
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def duration(self) -> timedelta | None:
        if self.started_at and self.completed_at:
            return self.completed_at - self.started_at
        return None

    @property
    def is_active(self) -> bool:
        return self.status in (TaskStatus.SCHEDULED, TaskStatus.RUNNING)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "model": self.model,
            "priority": self.priority.value,
            "status": self.status.value,
            "scheduled_at": self.scheduled_at.isoformat() if self.scheduled_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "estimated_duration_seconds": self.estimated_duration.total_seconds(),
            "metadata": self.metadata,
        }


@dataclass
class ConflictResolution:
    """Result of resolving a scheduling conflict."""

    winner: ScheduledTask
    loser: ScheduledTask | None
    reason: str
    action: str  # "reschedule", "queue", "cancel"


class ScheduleManager:
    """Manages model workload scheduling with conflict resolution.

    Tracks which models are currently handling tasks, resolves conflicts
    when multiple tasks compete for the same model, and provides scheduling
    recommendations.
    """

    def __init__(self, max_concurrent_per_model: int = 3) -> None:
        self.tasks: dict[str, ScheduledTask] = {}
        self.max_concurrent_per_model = max_concurrent_per_model
        self._task_counter = 0

    def _next_id(self) -> str:
        self._task_counter += 1
        return f"task-{self._task_counter:04d}"

    def schedule(
        self,
        task_type: str,
        model: str,
        priority: TaskPriority = TaskPriority.MEDIUM,
        scheduled_at: datetime | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ScheduledTask:
        """Schedule a new task for a model."""
        task = ScheduledTask(
            task_id=self._next_id(),
            task_type=task_type,
            model=model,
            priority=priority,
            status=TaskStatus.SCHEDULED,
            scheduled_at=scheduled_at or datetime.now(),
            metadata=metadata or {},
        )
        self.tasks[task.task_id] = task
        return task

    def get_model_tasks(self, model: str, active_only: bool = False) -> list[ScheduledTask]:
        """Get all tasks for a model."""
        tasks = [t for t in self.tasks.values() if t.model == model]
        if active_only:
            tasks = [t for t in tasks if t.is_active]
        return sorted(tasks, key=lambda t: t.priority.value, reverse=True)

    def get_active_count(self, model: str) -> int:
        """Count active tasks for a model."""
        return len(self.get_model_tasks(model, active_only=True))

    def can_schedule(self, model: str) -> bool:
        """Check if a model has capacity for more tasks."""
        return self.get_active_count(model) < self.max_concurrent_per_model

    def resolve_conflict(
        self,
        task_a: ScheduledTask,
        task_b: ScheduledTask,
    ) -> ConflictResolution:
        """Resolve a conflict between two tasks competing for the same model.

        Priority wins. Same priority → earlier scheduled time wins.
        """
        if task_a.model != task_b.model:
            return ConflictResolution(
                winner=task_a,
                loser=None,
                reason="No conflict: different models",
                action="none",
            )

        # Higher priority wins
        if task_a.priority.value > task_b.priority.value:
            return ConflictResolution(
                winner=task_a, loser=task_b,
                reason=f"Priority: {task_a.priority.name} > {task_b.priority.name}",
                action="queue",
            )
        elif task_b.priority.value > task_a.priority.value:
            return ConflictResolution(
                winner=task_b, loser=task_a,
                reason=f"Priority: {task_b.priority.name} > {task_a.priority.name}",
                action="queue",
            )

        # Same priority — earlier scheduled_at wins
        a_time = task_a.scheduled_at or datetime.max
        b_time = task_b.scheduled_at or datetime.max
        if a_time <= b_time:
            return ConflictResolution(
                winner=task_a, loser=task_b,
                reason="Same priority, first scheduled wins",
                action="queue",
            )
        return ConflictResolution(
            winner=task_b, loser=task_a,
            reason="Same priority, first scheduled wins",
            action="queue",
        )

    def start_task(self, task_id: str) -> ScheduledTask | None:
        """Mark a task as running."""
        task = self.tasks.get(task_id)
        if task:
            task.status = TaskStatus.RUNNING
            task.started_at = datetime.now()
        return task

    def complete_task(self, task_id: str, success: bool = True) -> ScheduledTask | None:
        """Mark a task as completed or failed."""
        task = self.tasks.get(task_id)
        if task:
            task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
            task.completed_at = datetime.now()
        return task

    def cancel_task(self, task_id: str) -> ScheduledTask | None:
        """Cancel a task."""
        task = self.tasks.get(task_id)
        if task and task.is_active:
            task.status = TaskStatus.CANCELLED
        return task

    def get_pending(self, model: str | None = None) -> list[ScheduledTask]:
        """Get all pending/scheduled tasks, optionally filtered by model."""
        tasks = [t for t in self.tasks.values() if t.status in (TaskStatus.PENDING, TaskStatus.SCHEDULED)]
        if model:
            tasks = [t for t in tasks if t.model == model]
        return sorted(tasks, key=lambda t: (t.priority.value, t.scheduled_at or datetime.max), reverse=True)

    def get_statistics(self) -> dict[str, Any]:
        """Get scheduling statistics."""
        total = len(self.tasks)
        by_status: dict[str, int] = {}
        by_model: dict[str, int] = {}
        for t in self.tasks.values():
            by_status[t.status.value] = by_status.get(t.status.value, 0) + 1
            by_model[t.model] = by_model.get(t.model, 0) + 1
        return {
            "total_tasks": total,
            "by_status": by_status,
            "by_model": by_model,
            "max_concurrent_per_model": self.max_concurrent_per_model,
        }
