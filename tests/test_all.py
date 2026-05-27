"""Comprehensive tests for casting_call_mcp."""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from casting_call_mcp.cast import CastCall
from casting_call_mcp.role import Actor, ModelCapability, Role
from casting_call_mcp.audition import Audition, AuditionReport, AuditionResult
from casting_call_mcp.schedule import (
    ScheduleManager,
    ScheduledTask,
    TaskPriority,
    TaskStatus,
    ConflictResolution,
)
from casting_call_mcp.server import MCPServer, load_database, save_database, MCP_TOOLS


# ── Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture
def sample_evaluations() -> list[dict]:
    return [
        {"model": "GPT-4", "task_type": "code_generation", "success": True, "quality": 5, "contributor": "alice"},
        {"model": "GPT-4", "task_type": "code_generation", "success": True, "quality": 4, "contributor": "bob"},
        {"model": "Claude", "task_type": "code_generation", "success": True, "quality": 4, "contributor": "alice"},
        {"model": "Claude", "task_type": "creative_writing", "success": True, "quality": 5, "contributor": "alice"},
        {"model": "Llama", "task_type": "code_generation", "success": False, "quality": 2, "contributor": "bob"},
        {"model": "Llama", "task_type": "summarization", "success": True, "quality": 4, "contributor": "carol"},
    ]


@pytest.fixture
def sample_db(tmp_path: Path) -> Path:
    db = {
        "evaluations": [
            {"model": "GPT-4", "task_type": "code_generation", "success": True, "quality": 5, "contributor": "alice"},
            {"model": "Claude", "task_type": "creative_writing", "success": True, "quality": 5, "contributor": "bob"},
        ],
        "task_templates": {
            "code_generation": {"recommended_model": "GPT-4", "temperature": 0.2},
        },
        "warnings": {},
    }
    path = tmp_path / "cast-log.json"
    path.write_text(json.dumps(db))
    return tmp_path


@pytest.fixture
def server(sample_db: Path) -> MCPServer:
    return MCPServer(data_dir=sample_db)


# ── CastCall Tests ────────────────────────────────────────────────────────

class TestCastCall:
    def test_basic_creation(self):
        cc = CastCall(task_description="Write a Python function to sort a list")
        assert cc.task_type == "code_generation"

    def test_explicit_type(self):
        cc = CastCall(task_description="something", task_type="creative_writing")
        assert cc.task_type == "creative_writing"

    def test_infer_analysis(self):
        cc = CastCall(task_description="Analyze the performance data")
        assert cc.task_type == "analysis"

    def test_infer_general(self):
        cc = CastCall(task_description="do stuff")
        assert cc.task_type == "general"

    def test_infer_debugging(self):
        cc = CastCall(task_description="Debug the error in main.py")
        assert cc.task_type == "debugging"

    def test_infer_documentation(self):
        cc = CastCall(task_description="Document the API endpoints")
        assert cc.task_type == "documentation"

    def test_infer_planning(self):
        cc = CastCall(task_description="Plan the next sprint")
        assert cc.task_type == "planning"

    def test_infer_summarization(self):
        cc = CastCall(task_description="Summarize the meeting notes")
        assert cc.task_type == "summarization"

    def test_matches_evaluation(self):
        cc = CastCall(task_description="code generation", task_type="code_generation")
        ev = {"task_type": "code_generation", "quality": 5, "success": True}
        score = cc.matches_evaluation(ev)
        assert 0.0 <= score <= 1.0
        assert score > 0.5

    def test_matches_evaluation_no_match(self):
        cc = CastCall(task_description="code generation", task_type="code_generation")
        ev = {"task_type": "creative_writing", "quality": 1, "success": False}
        score = cc.matches_evaluation(ev)
        assert score < 0.5

    def test_serialization(self):
        cc = CastCall(task_description="test", task_type="analysis")
        d = cc.to_dict()
        assert d["task_description"] == "test"
        assert d["task_type"] == "analysis"

    def test_deserialization(self):
        d = {"task_description": "hello", "task_type": "general"}
        cc = CastCall.from_dict(d)
        assert cc.task_description == "hello"

    def test_capabilities_and_metadata(self):
        cc = CastCall(
            task_description="test",
            required_capabilities=["code", "reasoning"],
            metadata={"key": "value"},
        )
        assert cc.required_capabilities == ["code", "reasoning"]
        assert cc.metadata["key"] == "value"


# ── Role / Actor Tests ────────────────────────────────────────────────────

class TestActor:
    def test_creation(self):
        a = Actor(name="GPT-4", capabilities={ModelCapability.CODE_GENERATION})
        assert a.name == "GPT-4"
        assert a.can_perform(ModelCapability.CODE_GENERATION)
        assert not a.can_perform(ModelCapability.CREATIVE_WRITING)

    def test_can_perform_all(self):
        a = Actor(name="Multi", capabilities={
            ModelCapability.CODE_GENERATION,
            ModelCapability.ANALYSIS,
        })
        assert a.can_perform_all({ModelCapability.CODE_GENERATION})
        assert not a.can_perform_all({ModelCapability.CODE_GENERATION, ModelCapability.CREATIVE_WRITING})

    def test_serialization(self):
        a = Actor(name="Test", capabilities={ModelCapability.CODE_GENERATION}, default_temperature=0.7)
        d = a.to_dict()
        assert d["name"] == "Test"
        assert "code_generation" in d["capabilities"]
        assert d["default_temperature"] == 0.7

    def test_deserialization(self):
        d = {"name": "Test", "capabilities": ["code_generation", "analysis"]}
        a = Actor.from_dict(d)
        assert a.name == "Test"
        assert ModelCapability.CODE_GENERATION in a.capabilities
        assert ModelCapability.ANALYSIS in a.capabilities

    def test_unknown_capability_ignored(self):
        d = {"name": "Test", "capabilities": ["nonexistent", "code_generation"]}
        a = Actor.from_dict(d)
        assert ModelCapability.CODE_GENERATION in a.capabilities
        assert len(a.capabilities) == 1


class TestRole:
    def test_match_score(self):
        actor = Actor(name="GPT-4", capabilities={
            ModelCapability.CODE_GENERATION,
            ModelCapability.REASONING,
        })
        role = Role(name="coder", capabilities={ModelCapability.CODE_GENERATION})
        score = role.match_score(actor)
        assert score > 0.3

    def test_excluded_actor(self):
        actor = Actor(name="Bad", capabilities={ModelCapability.CODE_GENERATION})
        role = Role(name="coder", excluded_actors=["Bad"])
        score = role.match_score(actor)
        assert score == 0.0

    def test_find_best_actor(self):
        actors = [
            Actor(name="Weak", capabilities=set()),
            Actor(name="Strong", capabilities={
                ModelCapability.CODE_GENERATION,
                ModelCapability.REASONING,
            }),
        ]
        role = Role(name="coder", capabilities={ModelCapability.CODE_GENERATION, ModelCapability.REASONING})
        best = role.find_best_actor(actors)
        assert best is not None
        assert best.name == "Strong"

    def test_find_best_actor_none_match(self):
        actors = [Actor(name="A", capabilities=set())]
        role = Role(name="coder", capabilities={ModelCapability.CODE_GENERATION}, excluded_actors=["A"])
        best = role.find_best_actor(actors)
        assert best is None

    def test_rank_actors(self):
        actors = [
            Actor(name="Low", capabilities={ModelCapability.CODE_GENERATION}),
            Actor(name="High", capabilities={
                ModelCapability.CODE_GENERATION,
                ModelCapability.REASONING,
                ModelCapability.ANALYSIS,
            }),
        ]
        role = Role(name="coder", capabilities={
            ModelCapability.CODE_GENERATION,
            ModelCapability.REASONING,
        })
        ranked = role.rank_actors(actors)
        assert len(ranked) == 2
        assert ranked[0][0].name == "High"
        assert ranked[0][1] >= ranked[1][1]

    def test_preferred_actor_bonus(self):
        actors = [Actor(name="A"), Actor(name="B")]
        role = Role(name="test", preferred_actors=["A"])
        scores = {a.name: role.match_score(a) for a in actors}
        assert scores["A"] > scores["B"]


# ── Audition Tests ────────────────────────────────────────────────────────

class TestAudition:
    def test_basic_audition(self, sample_evaluations):
        audition = Audition(sample_evaluations)
        report = audition.run(task_type="code_generation")
        assert report.winner is not None
        assert report.winner.candidate_name == "GPT-4"
        assert len(report.candidates) == 3  # GPT-4, Claude, Llama

    def test_trust_weighted(self, sample_evaluations):
        trust = {"alice": 1.0, "bob": 0.1, "carol": 0.5}
        audition = Audition(sample_evaluations, trust_weights=trust)
        report = audition.run(task_type="code_generation")
        assert report.winner is not None
        # GPT-4 has alice (1.0) + bob (0.1) = highly weighted
        assert report.winner.candidate_name == "GPT-4"

    def test_no_matching_evals(self, sample_evaluations):
        audition = Audition(sample_evaluations)
        report = audition.run(task_type="nonexistent_task")
        assert report.winner is None
        assert report.candidates == []

    def test_from_database(self):
        db = {
            "evaluations": [
                {"model": "A", "task_type": "test", "quality": 5, "success": True, "contributor": "x"},
            ],
            "default_trust": 0.7,
        }
        audition = Audition.from_database(db)
        assert audition.default_trust == 0.7
        assert len(audition.evaluations) == 1

    def test_audition_report_serialization(self, sample_evaluations):
        audition = Audition(sample_evaluations)
        report = audition.run(task_type="code_generation")
        d = report.to_dict()
        assert d["winner"] is not None
        assert d["winner"]["candidate_name"] == "GPT-4"
        assert len(d["candidates"]) == 3

    def test_single_candidate(self):
        evals = [
            {"model": "Only", "task_type": "test", "quality": 4, "success": True, "contributor": "a"},
        ]
        audition = Audition(evals)
        report = audition.run(task_type="test")
        assert report.winner is not None
        assert report.winner.candidate_name == "Only"

    def test_empty_evaluations(self):
        audition = Audition([])
        report = audition.run(task_type="anything")
        assert report.winner is None

    def test_audition_result_to_dict(self):
        ar = AuditionResult(
            candidate_name="Test", score=0.85, quality_avg=4.2,
            success_rate=0.9, observation_count=10, trust_weight=7.5,
            source_diversity=3, notes="Great model",
        )
        d = ar.to_dict()
        assert d["candidate_name"] == "Test"
        assert d["score"] == 0.85


# ── Schedule Manager Tests ────────────────────────────────────────────────

class TestScheduleManager:
    def test_schedule_task(self):
        sm = ScheduleManager()
        task = sm.schedule(task_type="code_generation", model="GPT-4")
        assert task.task_id == "task-0001"
        assert task.model == "GPT-4"
        assert task.status == TaskStatus.SCHEDULED

    def test_schedule_multiple(self):
        sm = ScheduleManager()
        t1 = sm.schedule("task_a", "GPT-4", priority=TaskPriority.HIGH)
        t2 = sm.schedule("task_b", "GPT-4", priority=TaskPriority.LOW)
        assert t1.task_id != t2.task_id
        assert len(sm.tasks) == 2

    def test_capacity_check(self):
        sm = ScheduleManager(max_concurrent_per_model=2)
        sm.schedule("t1", "GPT-4")
        sm.start_task("task-0001")
        assert sm.get_active_count("GPT-4") == 1
        assert sm.can_schedule("GPT-4")
        sm.schedule("t2", "GPT-4")
        sm.start_task("task-0002")
        assert not sm.can_schedule("GPT-4")

    def test_resolve_conflict_priority(self):
        sm = ScheduleManager()
        high = sm.schedule("important", "GPT-4", priority=TaskPriority.HIGH)
        low = sm.schedule("routine", "GPT-4", priority=TaskPriority.LOW)
        result = sm.resolve_conflict(high, low)
        assert result.winner == high
        assert result.loser == low
        assert "Priority" in result.reason

    def test_resolve_conflict_same_priority(self):
        sm = ScheduleManager()
        t1 = sm.schedule("first", "GPT-4", priority=TaskPriority.MEDIUM)
        t2 = sm.schedule("second", "GPT-4", priority=TaskPriority.MEDIUM)
        result = sm.resolve_conflict(t1, t2)
        assert result.winner == t1  # First scheduled

    def test_resolve_no_conflict(self):
        sm = ScheduleManager()
        t1 = sm.schedule("a", "GPT-4")
        t2 = sm.schedule("b", "Claude")
        result = sm.resolve_conflict(t1, t2)
        assert result.action == "none"

    def test_lifecycle(self):
        sm = ScheduleManager()
        task = sm.schedule("work", "GPT-4")
        assert task.status == TaskStatus.SCHEDULED

        sm.start_task(task.task_id)
        assert task.status == TaskStatus.RUNNING
        assert task.started_at is not None

        sm.complete_task(task.task_id, success=True)
        assert task.status == TaskStatus.COMPLETED
        assert task.completed_at is not None
        assert task.duration is not None

    def test_cancel(self):
        sm = ScheduleManager()
        task = sm.schedule("work", "GPT-4")
        result = sm.cancel_task(task.task_id)
        assert result is not None
        assert result.status == TaskStatus.CANCELLED

    def test_cancel_completed_task(self):
        sm = ScheduleManager()
        task = sm.schedule("work", "GPT-4")
        sm.start_task(task.task_id)
        sm.complete_task(task.task_id)
        result = sm.cancel_task(task.task_id)
        assert result is not None
        # Already completed, shouldn't cancel
        assert result.status == TaskStatus.COMPLETED

    def test_get_pending(self):
        sm = ScheduleManager()
        sm.schedule("a", "GPT-4", priority=TaskPriority.HIGH)
        sm.schedule("b", "Claude", priority=TaskPriority.LOW)
        pending = sm.get_pending()
        assert len(pending) == 2
        assert pending[0].priority == TaskPriority.HIGH

    def test_get_pending_by_model(self):
        sm = ScheduleManager()
        sm.schedule("a", "GPT-4")
        sm.schedule("b", "Claude")
        pending = sm.get_pending(model="GPT-4")
        assert len(pending) == 1

    def test_statistics(self):
        sm = ScheduleManager()
        sm.schedule("a", "GPT-4")
        sm.schedule("b", "Claude")
        sm.start_task("task-0001")
        stats = sm.get_statistics()
        assert stats["total_tasks"] == 2
        assert stats["by_status"]["running"] == 1
        assert stats["by_status"]["scheduled"] == 1

    def test_task_serialization(self):
        sm = ScheduleManager()
        task = sm.schedule("test", "GPT-4", priority=TaskPriority.HIGH)
        d = task.to_dict()
        assert d["task_type"] == "test"
        assert d["model"] == "GPT-4"
        assert d["priority"] == 3  # HIGH = 3

    def test_nonexistent_task(self):
        sm = ScheduleManager()
        assert sm.start_task("nonexistent") is None
        assert sm.complete_task("nonexistent") is None
        assert sm.cancel_task("nonexistent") is None

    def test_task_duration(self):
        sm = ScheduleManager()
        task = sm.schedule("test", "GPT-4")
        # No duration before start/complete
        assert task.duration is None


# ── Server Tests ──────────────────────────────────────────────────────────

class TestMCPServer:
    def test_list_tools(self, server):
        tools = server.list_tools()
        assert len(tools) == 6
        names = {t["name"] for t in tools}
        assert "cast_model" in names
        assert "log_result" in names
        assert "get_stats" in names
        assert "list_templates" in names
        assert "audition_models" in names
        assert "schedule_task" in names

    def test_tool_schemas(self, server):
        for tool in server.list_tools():
            assert "name" in tool
            assert "description" in tool
            assert "inputSchema" in tool

    def test_cast_model(self, server):
        result = server.call_tool("cast_model", {"task_description": "code generation"})
        assert "task_type" in result
        assert "recommended_model" in result

    def test_log_result(self, server):
        result = server.call_tool("log_result", {
            "model": "TestModel",
            "task_type": "testing",
            "success": True,
            "quality": 4,
            "contributor": "pytest",
        })
        assert result["status"] == "logged"
        assert result["entry"]["model"] == "TestModel"

    def test_get_stats(self, server):
        result = server.call_tool("get_stats", {})
        assert "total_evaluations" in result
        assert "models" in result
        assert result["total_evaluations"] >= 0

    def test_list_templates(self, server):
        result = server.call_tool("list_templates", {})
        assert "count" in result
        assert "templates" in result

    def test_audition_models(self, server):
        result = server.call_tool("audition_models", {
            "task_type": "code_generation",
        })
        assert "candidates" in result
        assert "winner" in result

    def test_schedule_task(self, server):
        result = server.call_tool("schedule_task", {
            "task_type": "code_generation",
            "model": "GPT-4",
            "priority": "HIGH",
        })
        assert result["task_type"] == "code_generation"
        assert result["model"] == "GPT-4"

    def test_unknown_tool(self, server):
        result = server.call_tool("nonexistent", {})
        assert "error" in result

    def test_reload(self, server, sample_db):
        server.reload()
        # Should still work after reload
        result = server.call_tool("get_stats", {})
        assert "total_evaluations" in result


# ── Database I/O Tests ────────────────────────────────────────────────────

class TestDatabaseIO:
    def test_load_nonexistent(self, tmp_path):
        db = load_database(tmp_path / "nonexistent.json")
        assert db["evaluations"] == []

    def test_save_and_load(self, tmp_path):
        db = {"evaluations": [{"model": "X"}], "task_templates": {}, "warnings": {}}
        path = tmp_path / "test.json"
        save_database(db, path)
        loaded = load_database(path)
        assert loaded["evaluations"][0]["model"] == "X"

    def test_load_corrupt(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json at all {{{")
        db = load_database(path)
        assert db["evaluations"] == []

    def test_save_creates_dirs(self, tmp_path):
        path = tmp_path / "deep" / "nested" / "db.json"
        save_database({"evaluations": []}, path)
        assert path.exists()


# ── MCP Tools Schema Validation ───────────────────────────────────────────

class TestMCPToolSchemas:
    def test_all_tools_have_required_fields(self):
        for tool in MCP_TOOLS:
            assert "name" in tool
            assert "description" in tool
            assert "inputSchema" in tool
            schema = tool["inputSchema"]
            assert schema["type"] == "object"
            assert "properties" in schema

    def test_tools_with_required_have_list(self):
        for tool in MCP_TOOLS:
            if "required" in tool["inputSchema"]:
                assert isinstance(tool["inputSchema"]["required"], list)
