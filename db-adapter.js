const { execFileSync } = require('child_process');

var sqliteDb = null;
var pgConfig = null;
var currentType = 'sqlite';

// When non-null we are inside a PG transaction and buffer translated write
// statements here so they can be flushed atomically as a single BEGIN/COMMIT.
var txBuffer = null;

function setSqlite(db) {
  sqliteDb = db;
  currentType = 'sqlite';
}

function setPg(config) {
  pgConfig = config;
  currentType = 'postgresql';
}

function getType() {
  return currentType;
}

// ---------------------------------------------------------------------------
// Low-level psql invocation
// ---------------------------------------------------------------------------

// Run already-translated SQL through psql.
//   tuplesOnly = true  -> -t -q (pure tuple output, used for SELECT / RETURNING)
//   tuplesOnly = false -> command tag is printed (used for INSERT/UPDATE/DELETE)
function runPsql(translatedSql, tuplesOnly) {
  if (!pgConfig) throw new Error('PostgreSQL backend is not configured');
  var args = ['-h', pgConfig.host, '-p', String(pgConfig.port), '-U', pgConfig.user, '-d', pgConfig.database, '-A', '-X', '-v', 'ON_ERROR_STOP=1'];
  if (tuplesOnly) args.push('-t', '-q');
  var env = Object.assign({}, process.env, { PGPASSWORD: pgConfig.password || '' });
  var body = translatedSql.trim();
  if (!body.endsWith(';')) body += ';';
  try {
    return execFileSync('psql', args, { input: body + '\n', encoding: 'utf8', timeout: 30000, env: env, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    var msg = e.stderr ? e.stderr.trim() : e.message;
    if (!msg && e.stdout) msg = e.stdout.trim();
    throw new Error(msg || 'psql error');
  }
}

function pgExec(sql, params) {
  return runPsql(translateSql(sql, params || []), false);
}

// Parse the affected-row count from a psql command tag (INSERT 0 N / UPDATE N / DELETE N).
function parseChanges(out) {
  if (!out) return 0;
  var lines = out.trim().split('\n');
  var last = lines[lines.length - 1].trim();
  var m = last.match(/^INSERT\s+\d+\s+(\d+)$/) || last.match(/^(?:UPDATE|DELETE)\s+(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// SQL translation (SQLite -> PostgreSQL)
// ---------------------------------------------------------------------------

function translateSql(sql, params) {
  params = params || [];
  var result = sql;
  var conflictClause = null;

  // INSERT OR REPLACE INTO settings (key, value) VALUES (...) -> proper upsert.
  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+settings/i.test(result)) {
    result = result.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+settings/gi, 'INSERT INTO settings');
    conflictClause = ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
  }

  // INSERT OR IGNORE INTO x -> INSERT INTO x ... ON CONFLICT DO NOTHING.
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(result)) {
    result = result.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    if (!conflictClause) conflictClause = ' ON CONFLICT DO NOTHING';
  }

  // datetime('now') / datetime('now','localtime') -> CURRENT_TIMESTAMP
  result = result.replace(/datetime\('now'(,\s*'localtime')?\)/g, 'CURRENT_TIMESTAMP');

  // GROUP_CONCAT(DISTINCT x) -> string_agg(DISTINCT x::text, ',')
  // The argument pattern allows one level of nested parens (e.g. COALESCE(x,'')).
  result = result.replace(/GROUP_CONCAT\(\s*DISTINCT\s+((?:[^()]|\([^()]*\))+?)\s*\)/gi, "string_agg(DISTINCT ($1)::text, ',')");
  // GROUP_CONCAT(x) -> string_agg(x::text, ',')
  result = result.replace(/GROUP_CONCAT\(\s*(?!DISTINCT)((?:[^()]|\([^()]*\))+?)\s*\)/gi, "string_agg(($1)::text, ',')");

  // Named parameters: better-sqlite3 binds a single object argument to
  // @name / :name / $name placeholders. Substitute them inline.
  var namedObj = null;
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    namedObj = params[0];
  }
  if (namedObj && /[@:$]\w+/.test(result)) {
    result = replaceNamedParams(result, namedObj);
    return appendConflict(result, conflictClause);
  }

  // Positional ? parameters, ignoring those inside single-quoted strings.
  var parts = [];
  var last = 0;
  var inStr = false;
  var paramIdx = 0;
  for (var i = 0; i < result.length; i++) {
    var ch = result[i];
    if (ch === "'") { inStr = !inStr; continue; }
    if (ch === '?' && !inStr) {
      parts.push(result.slice(last, i));
      parts.push(pgLiteral(params[paramIdx]));
      paramIdx++;
      last = i + 1;
    }
  }
  parts.push(result.slice(last));
  result = parts.join('');

  return appendConflict(result, conflictClause);
}

// Replace @name / :name / $name placeholders outside single-quoted strings.
function replaceNamedParams(sql, obj) {
  var out = '';
  var inStr = false;
  for (var i = 0; i < sql.length; i++) {
    var ch = sql[i];
    if (ch === "'") { inStr = !inStr; out += ch; continue; }
    if (!inStr && (ch === '@' || ch === ':' || ch === '$')) {
      // Skip PG '::' cast operator.
      if (ch === ':' && sql[i + 1] === ':') { out += '::'; i++; continue; }
      var m = sql.slice(i + 1).match(/^\w+/);
      if (m && Object.prototype.hasOwnProperty.call(obj, m[0])) {
        out += pgLiteral(obj[m[0]]);
        i += m[0].length;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function appendConflict(sql, clause) {
  if (!clause) return sql;
  if (/ON\s+CONFLICT/i.test(sql)) return sql;
  return sql.replace(/;?\s*$/, '') + clause;
}

function pgLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Date) val = val.toISOString();
  // standard_conforming_strings is on by default in PostgreSQL, so backslashes
  // are literal; only single quotes need doubling.
  var s = String(val).replace(/'/g, "''");
  return "'" + s + "'";
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

function isReadQuery(sql) {
  return /^\s*(SELECT|WITH)/i.test(sql);
}

function flushTxBuffer() {
  if (txBuffer && txBuffer.length) {
    var stmts = txBuffer;
    txBuffer = [];
    runPsql('BEGIN;\n' + stmts.join(';\n') + ';\nCOMMIT;', false);
  }
}

function prepare(sql) {
  return {
    get: function() {
      if (currentType === 'postgresql') {
        return pgQueryGet(sql, Array.prototype.slice.call(arguments));
      }
      var s = sqliteDb.prepare(sql);
      return s.get.apply(s, arguments);
    },
    all: function() {
      if (currentType === 'postgresql') {
        return pgQueryAll(sql, Array.prototype.slice.call(arguments));
      }
      var s = sqliteDb.prepare(sql);
      return s.all.apply(s, arguments);
    },
    run: function() {
      if (currentType === 'postgresql') {
        return pgQueryRun(sql, Array.prototype.slice.call(arguments));
      }
      var s = sqliteDb.prepare(sql);
      return s.run.apply(s, arguments);
    }
  };
}

function exec(sql) {
  if (currentType === 'sqlite') {
    return sqliteDb.exec(sql);
  }
  return runPsql(sql, false);
}

// Insert a row and return the new id, in both backends.
//   SQLite: lastInsertRowid. PostgreSQL: INSERT ... RETURNING id.
function runReturningId(sql, params) {
  if (currentType === 'sqlite') {
    var s = sqliteDb.prepare(sql);
    var info = s.run.apply(s, params || []);
    return info.lastInsertRowid;
  }
  var translated = translateSql(sql, params || []).replace(/;?\s*$/, '') + ' RETURNING id';
  var out = runPsql(translated, true);
  var v = (out || '').trim().split('\n')[0].trim();
  if (!v) return undefined;
  var n = Number(v);
  return isNaN(n) ? v : n;
}

// better-sqlite3 exposes db.transaction(fn) which returns a wrapped function.
// SQLite: delegate to the real transaction. PostgreSQL: buffer all write
// statements produced inside fn and flush them as one atomic BEGIN/COMMIT batch.
function transaction(fn) {
  if (currentType === 'sqlite') {
    return sqliteDb.transaction(fn);
  }
  return function() {
    var prev = txBuffer;
    txBuffer = [];
    try {
      var r = fn.apply(this, arguments);
      var stmts = txBuffer;
      txBuffer = prev;
      if (stmts.length) {
        runPsql('BEGIN;\n' + stmts.join(';\n') + ';\nCOMMIT;', false);
      }
      return r;
    } catch (e) {
      txBuffer = prev;
      throw e;
    }
  };
}

function pgQueryGet(sql, params) {
  if (isReadQuery(sql)) {
    flushTxBuffer();
    var jsonSql = 'SELECT row_to_json(t) FROM (' + sql.replace(/;\s*$/, '') + ') t LIMIT 1';
    var stdout = runPsql(translateSql(jsonSql, params), true);
    if (stdout && stdout.trim()) {
      try { return JSON.parse(stdout.trim().split('\n')[0]); } catch (e) {}
    }
    return undefined;
  }
  pgQueryRun(sql, params);
  return undefined;
}

function pgQueryAll(sql, params) {
  if (isReadQuery(sql)) {
    flushTxBuffer();
    var jsonSql = 'SELECT row_to_json(t) FROM (' + sql.replace(/;\s*$/, '') + ') t';
    var stdout = runPsql(translateSql(jsonSql, params), true);
    if (stdout && stdout.trim()) {
      var lines = stdout.trim().split('\n').filter(function(l) { return l.trim(); });
      var result = [];
      for (var i = 0; i < lines.length; i++) {
        try { result.push(JSON.parse(lines[i])); } catch (e) {}
      }
      return result;
    }
    return [];
  }
  pgQueryRun(sql, params);
  return [];
}

function pgQueryRun(sql, params) {
  var translated = translateSql(sql, params || []);
  if (txBuffer) {
    txBuffer.push(translated);
    return { changes: 1, lastInsertRowid: undefined };
  }
  var out = runPsql(translated, false);
  return { changes: parseChanges(out), lastInsertRowid: undefined };
}

module.exports = { setSqlite, setPg, getType, prepare, exec, transaction, runReturningId };
