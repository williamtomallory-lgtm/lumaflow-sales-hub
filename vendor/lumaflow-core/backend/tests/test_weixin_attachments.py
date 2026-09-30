from __future__ import annotations

import hashlib
import sqlite3
import sys
import unittest
from pathlib import Path

# The repository currently has no Python packaging metadata; make the local
# namespace packages importable when the standalone ``pytest.exe`` launcher
# does not put the working directory on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.attachments import AttachmentPathError, AttachmentSizeError, AttachmentStore
from channel.weixin.attachments import (
    append_legacy_attachment_text,
    parse_legacy_attachment_markers,
    persist_weixin_attachments,
)


def _workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "agent-workspace"
    allowed = workspace / "tmp"
    allowed.mkdir(parents=True)
    return workspace, allowed


class WeixinAttachmentTests(unittest.TestCase):
  def test_explicit_tmp_root_cannot_escape_workspace(self) -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
      workspace = Path(temporary) / "workspace"
      outside_tmp = Path(temporary) / "tmp"
      with self.assertRaises(AttachmentPathError):
          AttachmentStore(workspace, tmp_root=outside_tmp)

  def test_persists_structured_metadata_and_keeps_legacy_marker(self) -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
      workspace, allowed = _workspace(Path(temporary))
      source = allowed / "报价图片.png"
      content = b"synthetic attachment bytes only"
      source.write_bytes(content)
      store = AttachmentStore(workspace)

      batch = persist_weixin_attachments(
          store,
          session_id="weixin-user-1",
          message_id="msg-001",
          attachments=[{"kind": "image", "name": source.name, "path": str(source), "mime": "image/png"}],
      )

      self.assertTrue(batch.all_succeeded)
      self.assertEqual(len(batch.records), 1)
      record = batch.records[0]
      self.assertTrue(record.id)
      self.assertEqual(record.session_id, "weixin-user-1")
      self.assertEqual(record.message_id, "msg-001")
      self.assertEqual(record.kind, "image")
      self.assertEqual(record.name, source.name)
      self.assertEqual(record.mime, "image/png")
      self.assertEqual(record.size, len(content))
      self.assertEqual(record.hash, hashlib.sha256(content).hexdigest())
      self.assertEqual(record.source, "weixin")
      self.assertEqual(record.status, "stored")
      self.assertTrue(record.created_at)
      managed_path = Path(record.path).resolve()
      self.assertEqual(managed_path.parent, (allowed / "attachments").resolve())
      self.assertEqual(managed_path.read_bytes(), content)
      self.assertEqual(batch.legacy_text, f"[图片: {record.path}]")
      self.assertTrue(append_legacy_attachment_text("客户发来图片", batch).endswith(batch.legacy_text))
      self.assertEqual(parse_legacy_attachment_markers(batch.legacy_text), (("image", record.path),))


  def test_metadata_survives_restart_and_hash_deduplicates_storage(self) -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
      workspace, allowed = _workspace(Path(temporary))
      source = allowed / "params.pdf"
      source.write_bytes(b"same synthetic bytes")
      database = workspace / "sessions.sqlite3"

      first_store = AttachmentStore(workspace, database_path=database)
      first = first_store.persist(session_id="s", message_id="m", kind="file", name="params.pdf", path=source, mime="application/pdf")
      duplicate = first_store.persist(session_id="s", message_id="m", kind="file", name="renamed.pdf", path=source, mime="application/pdf")
      second_message = first_store.persist(session_id="s", message_id="m-2", kind="file", name="params.pdf", path=source, mime="application/pdf")

      self.assertEqual(duplicate.id, first.id)
      self.assertEqual(duplicate.status, "duplicate")
      self.assertNotEqual(second_message.id, first.id)
      self.assertEqual(second_message.path, first.path)
      self.assertEqual(len(list((allowed / "attachments").glob("*.bin"))), 1)

      restarted = AttachmentStore(workspace, database_path=database)
      records = restarted.list(session_id="s")
      self.assertEqual([record.message_id for record in records], ["m", "m-2"])
      self.assertEqual(restarted.find_by_hash(first.hash)[0].hash, first.hash)
      connection = sqlite3.connect(database)
      try:
          self.assertEqual(connection.execute("SELECT COUNT(*) FROM attachments").fetchone()[0], 2)
      finally:
          connection.close()


  def test_path_escape_and_size_cap_are_rejected_without_db_records(self) -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
      workspace, allowed = _workspace(Path(temporary))
      outside = Path(temporary) / "outside-secret.txt"
      outside.write_bytes(b"must not be read")
      too_large = allowed / "large.bin"
      too_large.write_bytes(b"0123456789")
      store = AttachmentStore(workspace, max_attachment_bytes=4)

      with self.assertRaises(AttachmentPathError):
          store.persist(session_id="s", message_id="escape", kind="file", name="secret.txt", path=outside)
      with self.assertRaises(AttachmentSizeError):
          store.persist(session_id="s", message_id="large", kind="file", name="large.bin", path=too_large)
      self.assertEqual(store.list(), ())
      self.assertEqual(list((allowed / "attachments").glob("*")), [])


  def test_weixin_batch_keeps_good_files_and_hides_rejected_paths(self) -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as temporary:
      workspace, allowed = _workspace(Path(temporary))
      good = allowed / "good.txt"
      good.write_text("safe synthetic text", encoding="utf-8")
      outside = Path(temporary) / "private.txt"
      outside.write_text("private synthetic text", encoding="utf-8")
      store = AttachmentStore(workspace)

      batch = persist_weixin_attachments(
          store,
          session_id="s",
          message_id="m",
          attachments=[
              {"type": "file", "filename": "good.txt", "file_path": str(good), "content_type": "text/plain"},
              {"type": "file", "filename": "private.txt", "file_path": str(outside), "content_type": "text/plain"},
          ],
      )

      self.assertEqual([record.name for record in batch.records], ["good.txt"])
      self.assertEqual(len(batch.rejected), 1)
      rejected = batch.rejected[0]
      self.assertEqual(rejected.status, "rejected")
      self.assertEqual(rejected.code, "ATTACHMENT_PATH_DENIED")
      self.assertNotIn("private.txt", batch.legacy_text)
      self.assertNotIn("private synthetic text", repr(batch))
      self.assertNotIn("outside-secret", repr(batch))


if __name__ == "__main__":
  unittest.main()
