import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent.work import ActivityFeed, WorkNotFoundError, WorkStore


def _new_work(store, work_id="work-1", **overrides):
    values = {
        "work_id": work_id,
        "session_id": "web:customer-1",
        "agent_id": "sales",
        "title": "生成库存表",
        "kind": "inventory_export",
        "input": {"category": "轨道灯", "quantity": 20},
    }
    values.update(overrides)
    return store.create_work_item(**values)


def test_create_get_and_json_round_trip(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    item = _new_work(store)

    assert item["id"] == "work-1"
    assert item["status"] == "pending"
    assert item["progress"] == 0
    assert item["requires_approval"] is False
    assert item["approval_status"] == "not_required"
    assert item["input"] == {"category": "轨道灯", "quantity": 20}
    assert item["output"] is None
    assert store.get_work_item("work-1") == item


def test_work_id_is_idempotent_and_does_not_overwrite(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    first = _new_work(store)
    repeated = _new_work(store, title="不应覆盖", input={"different": True})

    assert repeated == first
    assert store.list_work_items_page()["total"] == 1


def test_update_progress_status_output_and_error(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    _new_work(store)

    running = store.update_progress("work-1", 37.5)
    assert running["progress"] == 37.5

    completed = store.update_status(
        "work-1", "completed", output={"file": "库存.xlsx"}, error=None
    )
    assert completed["status"] == "completed"
    assert completed["progress"] == 100
    assert completed["output"] == {"file": "库存.xlsx"}
    assert completed["error"] is None


def test_approval_validation_and_update(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    item = _new_work(store, requires_approval=True)
    assert item["approval_status"] == "pending"
    assert store.set_approval_status("work-1", "approved")["approval_status"] == "approved"

    _new_work(store, work_id="ordinary")
    with pytest.raises(ValueError, match="approval status must"):
        store.set_approval_status("ordinary", "approved")


@pytest.mark.parametrize("progress", [-1, 101, float("nan"), float("inf"), True, "20"])
def test_progress_validation(tmp_path, progress):
    store = WorkStore(tmp_path / "work.db")
    _new_work(store)
    with pytest.raises(ValueError, match="progress"):
        store.update_progress("work-1", progress)


def test_status_and_json_validation(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    _new_work(store)
    with pytest.raises(ValueError, match="invalid work status"):
        store.update_status("work-1", "done-ish")
    with pytest.raises(ValueError, match="JSON serializable"):
        store.update_status("work-1", "completed", output={"bad": object()})


def test_missing_update_raises_specific_error(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    with pytest.raises(WorkNotFoundError):
        store.update_status("missing", "running")


def test_filtered_paginated_work_listing(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    _new_work(store, work_id="1", session_id="s1", agent_id="a1")
    _new_work(store, work_id="2", session_id="s2", agent_id="a1", status="running")
    _new_work(store, work_id="3", session_id="s1", agent_id="a2")

    page = store.list_work_items_page(agent_id="a1", offset=0, limit=1)
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert {item["id"] for item in store.list_work_items(session_id="s1")} == {"1", "3"}
    assert [item["id"] for item in store.list_work_items(status="running")] == ["2"]


def test_activity_feed_append_cursor_and_pagination(tmp_path):
    store = WorkStore(tmp_path / "work.db")
    _new_work(store)
    feed = ActivityFeed(store)

    first = feed.append_event("work-1", "started", "开始", {"step": 1})
    second = feed.append("work-1", "progress", "处理中", {"progress": 50})
    third = feed.append("work-1", "finished", "完成")

    assert first["id"] < second["id"] < third["id"]
    assert feed.get_event(first["id"])["data"] == {"step": 1}
    assert [event["id"] for event in feed.list_events(after_id=first["id"])] == [
        second["id"],
        third["id"],
    ]
    page = feed.list_events_page(work_id="work-1", offset=1, limit=1)
    assert page["total"] == 3
    assert page["items"][0]["id"] == second["id"]


def test_activity_rejects_missing_work_and_bad_json(tmp_path):
    feed = ActivityFeed(tmp_path / "work.db")
    with pytest.raises(WorkNotFoundError):
        feed.append_event("missing", "started", "no work")

    store = feed.store
    _new_work(store)
    with pytest.raises(ValueError, match="JSON serializable"):
        feed.append_event("work-1", "progress", "bad", {"x": float("nan")})


def test_corrupt_json_is_contained_to_affected_field(tmp_path):
    db_path = tmp_path / "work.db"
    store = WorkStore(db_path)
    _new_work(store)
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("UPDATE work_items SET input = ? WHERE id = ?", ("{bad", "work-1"))
    assert store.get_work_item("work-1")["input"] == {}


def test_concurrent_idempotent_create_and_event_append(tmp_path):
    db_path = tmp_path / "work.db"
    stores = [WorkStore(db_path) for _ in range(8)]

    def create(index):
        return _new_work(stores[index % len(stores)])["id"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert set(pool.map(create, range(32))) == {"work-1"}

    def append(index):
        feed = ActivityFeed(stores[index % len(stores)])
        return feed.append("work-1", "progress", "event", {"index": index})["id"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        event_ids = list(pool.map(append, range(40)))

    assert len(event_ids) == len(set(event_ids)) == 40
    assert len(ActivityFeed(stores[0]).list_events(limit=100)) == 40


def test_database_columns_match_public_contract(tmp_path):
    db_path = tmp_path / "work.db"
    WorkStore(db_path)
    with sqlite3.connect(str(db_path)) as conn:
        work_columns = {row[1] for row in conn.execute("PRAGMA table_info(work_items)")}
        event_columns = {row[1] for row in conn.execute("PRAGMA table_info(activity_events)")}
        version = conn.execute(
            "SELECT value FROM _work_store_meta WHERE key = 'schema_version'"
        ).fetchone()[0]

    assert work_columns == {
        "id", "session_id", "agent_id", "title", "kind", "status", "progress",
        "requires_approval", "approval_status", "input", "output", "error",
        "created_at", "updated_at",
    }
    assert event_columns == {"id", "work_id", "type", "message", "data", "created_at"}
    assert version == "1"
