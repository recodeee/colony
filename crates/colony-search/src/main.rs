use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, Schema, TantivyDocument, INDEXED, STORED, STRING, TEXT};
use tantivy::{Document, Index, IndexWriter};

const INDEX_SCHEMA_VERSION: u32 = 1;
const META_FILE: &str = "colony-search-meta.json";
const WRITER_HEAP_BYTES: usize = 64_000_000;

#[derive(Debug, Deserialize)]
struct SearchRequest {
    db_path: PathBuf,
    index_dir: PathBuf,
    query: String,
    limit: usize,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct IndexMeta {
    schema_version: u32,
    max_id: i64,
    row_count: i64,
}

#[derive(Debug)]
struct ObservationRow {
    id: i64,
    session_id: String,
    kind: String,
    content: String,
    ts: i64,
    task_id: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
struct SearchFields {
    id: Field,
    session_id: Field,
    kind: Field,
    content: Field,
    ts: Field,
    task_id: Field,
}

#[derive(Debug, Serialize)]
struct SearchResponse {
    hits: Vec<SearchHit>,
    indexed_count: i64,
}

#[derive(Debug, Serialize)]
struct SearchHit {
    id: u64,
    session_id: String,
    kind: String,
    snippet: String,
    score: f32,
    ts: i64,
    task_id: Option<i64>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("search") => search_from_stdin(),
        Some(other) => Err(anyhow!("unknown command: {other}")),
        None => Err(anyhow!("missing command")),
    }
}

fn search_from_stdin() -> Result<()> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw)?;
    let request: SearchRequest = serde_json::from_str(&raw).context("invalid search request")?;
    let limit = request.limit.max(1);
    let conn = open_colony_db(&request.db_path)?;
    let (index, fields, meta) = open_synced_index(&conn, &request.index_dir)?;

    let reader = index.reader()?;
    let searcher = reader.searcher();
    let parser = QueryParser::for_index(&index, vec![fields.content]);
    let query = parser
        .parse_query(&request.query)
        .or_else(|_| parser.parse_query(&escape_query(&request.query)))
        .context("failed to parse query")?;
    let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

    let schema = index.schema();
    let mut hits = Vec::with_capacity(top_docs.len());
    for (score, address) in top_docs {
        let doc = searcher.doc::<TantivyDocument>(address)?;
        if let Some(hit) = hit_from_doc(score, &schema, &doc)? {
            hits.push(hit);
        }
    }

    println!(
        "{}",
        serde_json::to_string(&SearchResponse {
            hits,
            indexed_count: meta.row_count,
        })?
    );
    Ok(())
}

fn open_colony_db(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open SQLite DB at {}", path.display()))
}

fn open_synced_index(
    conn: &Connection,
    index_dir: &Path,
) -> Result<(Index, SearchFields, IndexMeta)> {
    let current = current_db_meta(conn)?;
    let mut meta = read_index_meta(index_dir).unwrap_or_default();
    let needs_rebuild =
        meta.schema_version != INDEX_SCHEMA_VERSION || current.row_count < meta.row_count;
    if needs_rebuild && index_dir.exists() {
        fs::remove_dir_all(index_dir)
            .with_context(|| format!("failed to remove stale index {}", index_dir.display()))?;
        meta = IndexMeta::default();
    }

    let index = open_or_create_index(index_dir)?;
    let fields = SearchFields::from_schema(&index.schema())?;
    let start_id = if meta.schema_version == INDEX_SCHEMA_VERSION {
        meta.max_id
    } else {
        0
    };
    if current.max_id > start_id {
        index_observations_since(conn, &index, fields, start_id)?;
        meta = current;
        meta.schema_version = INDEX_SCHEMA_VERSION;
        write_index_meta(index_dir, &meta)?;
    }
    Ok((index, fields, meta))
}

fn open_or_create_index(index_dir: &Path) -> Result<Index> {
    fs::create_dir_all(index_dir)
        .with_context(|| format!("failed to create index dir {}", index_dir.display()))?;
    if index_dir.join("meta.json").exists() {
        return Index::open_in_dir(index_dir)
            .with_context(|| format!("failed to open Tantivy index {}", index_dir.display()));
    }
    Index::create_in_dir(index_dir, build_schema())
        .with_context(|| format!("failed to create Tantivy index {}", index_dir.display()))
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_u64_field("id", INDEXED | STORED);
    builder.add_text_field("session_id", STRING | STORED);
    builder.add_text_field("kind", STRING | STORED);
    builder.add_text_field("content", TEXT | STORED);
    builder.add_i64_field("ts", INDEXED | STORED);
    builder.add_i64_field("task_id", INDEXED | STORED);
    builder.build()
}

impl SearchFields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        Ok(Self {
            id: schema.get_field("id")?,
            session_id: schema.get_field("session_id")?,
            kind: schema.get_field("kind")?,
            content: schema.get_field("content")?,
            ts: schema.get_field("ts")?,
            task_id: schema.get_field("task_id")?,
        })
    }
}

fn current_db_meta(conn: &Connection) -> Result<IndexMeta> {
    conn.query_row(
        "SELECT COALESCE(MAX(id), 0), COUNT(*) FROM observations",
        [],
        |row| {
            Ok(IndexMeta {
                schema_version: INDEX_SCHEMA_VERSION,
                max_id: row.get(0)?,
                row_count: row.get(1)?,
            })
        },
    )
    .context("failed to read observation high-water mark")
}

fn index_observations_since(
    conn: &Connection,
    index: &Index,
    fields: SearchFields,
    start_id: i64,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, kind, content, ts, task_id
         FROM observations
         WHERE id > ?1
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([start_id], |row| {
        Ok(ObservationRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            kind: row.get(2)?,
            content: row.get(3)?,
            ts: row.get(4)?,
            task_id: row.get(5)?,
        })
    })?;

    let mut writer: IndexWriter = index.writer(WRITER_HEAP_BYTES)?;
    for row in rows {
        let row = row?;
        let mut doc = TantivyDocument::default();
        doc.add_u64(fields.id, row.id as u64);
        doc.add_text(fields.session_id, &row.session_id);
        doc.add_text(fields.kind, &row.kind);
        doc.add_text(fields.content, &row.content);
        doc.add_i64(fields.ts, row.ts);
        doc.add_i64(fields.task_id, row.task_id.unwrap_or(-1));
        writer.add_document(doc)?;
    }
    writer.commit()?;
    Ok(())
}

fn read_index_meta(index_dir: &Path) -> Result<IndexMeta> {
    let raw = fs::read_to_string(index_dir.join(META_FILE))?;
    Ok(serde_json::from_str(&raw)?)
}

fn write_index_meta(index_dir: &Path, meta: &IndexMeta) -> Result<()> {
    fs::write(
        index_dir.join(META_FILE),
        format!("{}\n", serde_json::to_string_pretty(meta)?),
    )?;
    Ok(())
}

fn hit_from_doc(score: f32, schema: &Schema, doc: &TantivyDocument) -> Result<Option<SearchHit>> {
    let json: Value = serde_json::from_str(&doc.to_json(schema))?;
    let Some(id) = json_u64(&json, "id") else {
        return Ok(None);
    };
    let content = json_string(&json, "content").unwrap_or_default();
    let task_id = match json_i64(&json, "task_id") {
        Some(value) if value >= 0 => Some(value),
        _ => None,
    };
    Ok(Some(SearchHit {
        id,
        session_id: json_string(&json, "session_id").unwrap_or_default(),
        kind: json_string(&json, "kind").unwrap_or_default(),
        snippet: compact_snippet(&content, 180),
        score,
        ts: json_i64(&json, "ts").unwrap_or_default(),
        task_id,
    }))
}

fn json_field<'a>(json: &'a Value, key: &str) -> Option<&'a Value> {
    match json.get(key)? {
        Value::Array(items) => items.first(),
        value => Some(value),
    }
}

fn json_u64(json: &Value, key: &str) -> Option<u64> {
    json_field(json, key).and_then(Value::as_u64)
}

fn json_i64(json: &Value, key: &str) -> Option<i64> {
    json_field(json, key).and_then(Value::as_i64)
}

fn json_string(json: &Value, key: &str) -> Option<String> {
    json_field(json, key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn compact_snippet(content: &str, max_chars: usize) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let mut out: String = compact.chars().take(max_chars.saturating_sub(1)).collect();
    out.push_str("...");
    out
}

fn escape_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}
