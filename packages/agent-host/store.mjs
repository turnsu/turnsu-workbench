import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && (dir.mode & 0o077)) || (process.getuid && dir.uid !== process.getuid())) throw new Error("本地数据目录权限不安全，请使用仅自己可访问的目录。");
  const lock = join(directory, "host.lock");
  if (lstatSafe(lock)) {
    const before = lstatSync(lock);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("本地工作台锁文件不可用。");
    let pid;
    try { pid = JSON.parse(readFileSync(lock, "utf8")).pid; } catch { throw new Error("本地工作台锁文件损坏，请保留文件并检查运行状态。"); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error("本地工作台锁文件无效。");
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
    if (alive) throw new Error("这个本地工作台已经打开，请回到原窗口。");
    if (lstatSync(lock).ino !== before.ino) throw new Error("工作台正在启动，请稍后重试。");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd);
  const path = join(directory, "local.sqlite");
  if (lstatSafe(path)?.isSymbolicLink()) { unlinkSync(lock); throw new Error("本地数据库不可指向其他位置。"); }
  let db;
  try {
    db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_preferences(scope TEXT PRIMARY KEY, agent_id TEXT NOT NULL CHECK(agent_id IN ('codex','pi','claude','opencode')));
      CREATE TABLE IF NOT EXISTS wechat_imports(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), batch_id TEXT NOT NULL, chat_name TEXT, item_count INTEGER NOT NULL, record_count INTEGER NOT NULL, unparsed_count INTEGER NOT NULL, imported_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS wechat_imports_project_recent ON wechat_imports(project_id,imported_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS wechat_records(import_id TEXT NOT NULL REFERENCES wechat_imports(id), position INTEGER NOT NULL, source_item_id TEXT NOT NULL, sender TEXT NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(import_id,position));
      CREATE TABLE IF NOT EXISTS wechat_items(import_id TEXT NOT NULL REFERENCES wechat_imports(id), id TEXT NOT NULL, display_name TEXT NOT NULL, relative_path TEXT NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, parsed INTEGER NOT NULL, PRIMARY KEY(import_id,id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), native_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), prompt TEXT NOT NULL, native_turn_id TEXT, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_project_recent ON sessions(project_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
      CREATE TABLE IF NOT EXISTS drafts(project_id TEXT PRIMARY KEY REFERENCES projects(id), text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_drafts(session_id TEXT PRIMARY KEY REFERENCES sessions(id), text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reference_drafts(project_id TEXT NOT NULL REFERENCES projects(id),session_id TEXT NOT NULL,paths TEXT NOT NULL,PRIMARY KEY(project_id,session_id));
      CREATE TABLE IF NOT EXISTS work_reference_denials(session_id TEXT NOT NULL REFERENCES sessions(id),source_work_id TEXT NOT NULL,PRIMARY KEY(session_id,source_work_id));
      CREATE TABLE IF NOT EXISTS project_member_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS project_creation_drafts(id TEXT PRIMARY KEY,local_project_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS input_references(input_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),prompt TEXT NOT NULL,paths TEXT NOT NULL,files TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_projects(project_id TEXT PRIMARY KEY REFERENCES projects(id), remote_id TEXT NOT NULL, identity TEXT NOT NULL, title TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', conflicts TEXT NOT NULL DEFAULT '[]', issues TEXT NOT NULL DEFAULT '[]', synced_at INTEGER);
      CREATE TABLE IF NOT EXISTS shared_files(project_id TEXT NOT NULL REFERENCES shared_projects(project_id), path TEXT NOT NULL, revision_id TEXT, content_hash TEXT, conflict_id TEXT, conflict_hash TEXT, PRIMARY KEY(project_id,path));
      CREATE TABLE IF NOT EXISTS shared_outbox(project_id TEXT NOT NULL REFERENCES shared_projects(project_id), path TEXT NOT NULL, input_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,path));
      CREATE TABLE IF NOT EXISTS shared_incoming(project_id TEXT NOT NULL REFERENCES shared_projects(project_id), path TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY(project_id,path));
      CREATE TABLE IF NOT EXISTS work_decision_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS work_result_actions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS work_handoff_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,etag TEXT NOT NULL,payload TEXT NOT NULL,patch TEXT,status TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS shared_work_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id), work_item_id TEXT, identity TEXT NOT NULL, context TEXT, error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS shared_work_starts(request_id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id), request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_work_outbox(session_id TEXT NOT NULL REFERENCES shared_work_sessions(session_id), source_id TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE, sent_at INTEGER, PRIMARY KEY(session_id,source_id,part));
      CREATE TABLE IF NOT EXISTS shared_work_turns(input_id TEXT PRIMARY KEY REFERENCES submissions(id), session_id TEXT NOT NULL REFERENCES sessions(id), context TEXT NOT NULL, wire_prompt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_method_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id), receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_method_starts(request_id TEXT PRIMARY KEY, request TEXT NOT NULL, session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS method_captures(id TEXT PRIMARY KEY,source_session_id TEXT NOT NULL REFERENCES sessions(id),source_message_id TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),request TEXT NOT NULL,installed_content TEXT,installed_hash TEXT,installed_path TEXT);
      CREATE TABLE IF NOT EXISTS loop_captures(id TEXT PRIMARY KEY,source_session_id TEXT NOT NULL REFERENCES sessions(id),source_message_id TEXT NOT NULL,session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),request TEXT NOT NULL,instruction TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS loop_capture_saves(session_id TEXT PRIMARY KEY REFERENCES loop_captures(session_id),id TEXT UNIQUE NOT NULL,identity TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,receipts TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS local_loop_trials(id TEXT PRIMARY KEY,source_session_id TEXT NOT NULL REFERENCES loop_captures(session_id),session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),request TEXT NOT NULL,recipe TEXT NOT NULL,dependencies TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_loop_trial_deliveries(trial_id TEXT PRIMARY KEY REFERENCES local_loop_trials(id),actor TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS local_loop_publications(trial_id TEXT PRIMARY KEY REFERENCES local_loop_trials(id),actor TEXT NOT NULL,identity TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS native_loop_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id),request_id TEXT UNIQUE NOT NULL,request TEXT NOT NULL,package TEXT NOT NULL,dependencies TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS borrowed_agent_attempts(scope TEXT NOT NULL,invocation_id TEXT NOT NULL,attempt_id TEXT NOT NULL,contract TEXT NOT NULL,contract_hash TEXT NOT NULL,delivery_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('running','interrupted','failed','result_ready','delivered')),result TEXT,receipt TEXT,error_code TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,invocation_id),UNIQUE(scope,attempt_id));
      CREATE TABLE IF NOT EXISTS member_agent_actions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,actor TEXT NOT NULL,identity TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',receipt TEXT,error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS method_publications(session_id TEXT PRIMARY KEY REFERENCES sessions(id),id TEXT UNIQUE NOT NULL,identity TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,receipts TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS method_release_actions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES method_publications(session_id),kind TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,receipts TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS team_loop_preparations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,release_id TEXT NOT NULL,identity TEXT NOT NULL,actor TEXT NOT NULL,prepared TEXT,inputs TEXT NOT NULL,error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_loop_requests(id TEXT PRIMARY KEY,preparation_id TEXT NOT NULL REFERENCES team_loop_preparations(id),request TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,response TEXT);
      CREATE TABLE IF NOT EXISTS team_loop_actions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),work_item_id TEXT NOT NULL,run_id TEXT NOT NULL,identity TEXT NOT NULL,actor TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,response TEXT);
      UPDATE sessions SET status='interrupted' WHERE status IN ('starting','running','waiting','stopping');
      UPDATE submissions SET status='unknown' WHERE status='sending';`);
    db.exec("UPDATE borrowed_agent_attempts SET state='interrupted',error_code='borrowed_execution_interrupted' WHERE state='running'");
    if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_preferences'").get().sql.includes("'opencode'")) {
      db.exec("BEGIN IMMEDIATE; CREATE TABLE agent_preferences_next(scope TEXT PRIMARY KEY,agent_id TEXT NOT NULL CHECK(agent_id IN ('codex','pi','claude','opencode'))); INSERT INTO agent_preferences_next SELECT scope,agent_id FROM agent_preferences; DROP TABLE agent_preferences; ALTER TABLE agent_preferences_next RENAME TO agent_preferences; COMMIT");
    }
    for (const field of ['deleted', 'conflict_deleted', 'delete_ready']) if (!db.prepare('PRAGMA table_info(shared_files)').all().some(c => c.name === field)) db.exec(`ALTER TABLE shared_files ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
    if (!db.prepare('PRAGMA table_info(shared_outbox)').all().some(c => c.name === 'delete_ready')) db.exec('ALTER TABLE shared_outbox ADD COLUMN delete_ready INTEGER NOT NULL DEFAULT 0');
    if (!db.prepare('PRAGMA table_info(shared_projects)').all().some(c => c.name === 'scope')) db.exec('ALTER TABLE shared_projects ADD COLUMN scope TEXT');
    if (!db.prepare('PRAGMA table_info(shared_work_outbox)').all().some(c => c.name === 'file_revision_ids')) db.exec("ALTER TABLE shared_work_outbox ADD COLUMN file_revision_ids TEXT NOT NULL DEFAULT '[]'");
    if (!db.prepare('PRAGMA table_info(shared_work_outbox)').all().some(c => c.name === 'source_work_ids')) db.exec("ALTER TABLE shared_work_outbox ADD COLUMN source_work_ids TEXT NOT NULL DEFAULT '[]'");
    if (!db.prepare("PRAGMA table_info(sessions)").all().some(column => column.name === "connection_id")) db.exec("ALTER TABLE sessions ADD COLUMN connection_id TEXT");
    if (!db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "model")) db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    if (!db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "agent")) db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'codex'");
    if (!db.prepare('PRAGMA table_info(shared_work_sessions)').all().some(c => c.name === 'actor_user_id')) db.exec('ALTER TABLE shared_work_sessions ADD COLUMN actor_user_id TEXT');
    if (!db.prepare('PRAGMA table_info(shared_work_sessions)').all().some(c => c.name === 'access_state')) db.exec("ALTER TABLE shared_work_sessions ADD COLUMN access_state TEXT NOT NULL DEFAULT 'unknown'");
    if (!db.prepare('PRAGMA table_info(shared_work_starts)').all().some(c => c.name === 'create_data')) db.exec('ALTER TABLE shared_work_starts ADD COLUMN create_data TEXT');
    if (!db.prepare('PRAGMA table_info(method_captures)').all().some(c => c.name === 'instruction')) db.exec("ALTER TABLE method_captures ADD COLUMN instruction TEXT NOT NULL DEFAULT ''");
    if (!db.prepare('PRAGMA table_info(loop_captures)').all().some(c => c.name === 'catalog')) db.exec("ALTER TABLE loop_captures ADD COLUMN catalog TEXT NOT NULL DEFAULT 'null'");
    if (!db.prepare('PRAGMA table_info(local_loop_publications)').all().some(c => c.name === 'status')) db.exec("ALTER TABLE local_loop_publications ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  } catch (error) { db?.close(); unlinkSync(lock); throw error; }
  return { db, close() { db.close(); unlinkSync(lock); } };
}
function lstatSafe(path) { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
