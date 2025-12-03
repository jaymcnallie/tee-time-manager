const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'teetimes.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

// Initialize database
async function initDb() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Initialize tables
  db.run(`
    CREATE TABLE IF NOT EXISTS golfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      course TEXT,
      times TEXT NOT NULL,
      max_players INTEGER DEFAULT 16,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      golfer_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      position INTEGER,
      responded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (golfer_id) REFERENCES golfers(id),
      UNIQUE(event_id, golfer_id)
    )
  `);
  
  save();
  return db;
}

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Helper to run queries and save
function run(sql, params = []) {
  db.run(sql, params);
  save();
  return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Golfer queries
const addGolfer = {
  run: (name, phone) => run('INSERT OR IGNORE INTO golfers (name, phone) VALUES (?, ?)', [name, phone])
};

const getGolferByPhone = {
  get: (phone) => get('SELECT * FROM golfers WHERE phone = ?', [phone])
};

const getAllActiveGolfers = {
  all: () => all('SELECT * FROM golfers WHERE active = 1')
};

const updateGolferName = {
  run: (name, phone) => run('UPDATE golfers SET name = ? WHERE phone = ?', [name, phone])
};

// Event queries
const createEvent = {
  run: (date, course, times) => run('INSERT INTO events (date, course, times) VALUES (?, ?, ?)', [date, course, times])
};

const getActiveEvent = {
  get: () => get("SELECT * FROM events WHERE status = 'open' ORDER BY created_at DESC LIMIT 1")
};

const closeEvent = {
  run: (id) => run("UPDATE events SET status = 'closed' WHERE id = ?", [id])
};

const getEventById = {
  get: (id) => get('SELECT * FROM events WHERE id = ?', [id])
};

// Response queries
const upsertResponse = {
  run: (eventId, golferId, status, position) => {
    const existing = get('SELECT id FROM responses WHERE event_id = ? AND golfer_id = ?', [eventId, golferId]);
    if (existing) {
      run('UPDATE responses SET status = ?, position = ?, responded_at = CURRENT_TIMESTAMP WHERE event_id = ? AND golfer_id = ?', 
        [status, position, eventId, golferId]);
    } else {
      run('INSERT INTO responses (event_id, golfer_id, status, position) VALUES (?, ?, ?, ?)',
        [eventId, golferId, status, position]);
    }
  }
};

const getResponsesForEvent = {
  all: (eventId) => all(`
    SELECT r.*, g.name, g.phone
    FROM responses r
    JOIN golfers g ON r.golfer_id = g.id
    WHERE r.event_id = ?
    ORDER BY r.position ASC, r.responded_at ASC
  `, [eventId])
};

const getInCountForEvent = {
  get: (eventId) => get("SELECT COUNT(*) as count FROM responses WHERE event_id = ? AND status = 'in'", [eventId])
};

const getNextWaitlistPosition = {
  get: (eventId) => get("SELECT COALESCE(MAX(position), 16) + 1 as next_pos FROM responses WHERE event_id = ? AND status = 'in' AND position > 16", [eventId])
};

const getResponseByGolferAndEvent = {
  get: (eventId, golferId) => get('SELECT * FROM responses WHERE event_id = ? AND golfer_id = ?', [eventId, golferId])
};

const getFirstWaitlisted = {
  get: (eventId) => get(`
    SELECT r.*, g.name, g.phone
    FROM responses r
    JOIN golfers g ON r.golfer_id = g.id
    WHERE r.event_id = ? AND r.status = 'in' AND r.position > 16
    ORDER BY r.position ASC
    LIMIT 1
  `, [eventId])
};

const updatePosition = {
  run: (position, id) => run('UPDATE responses SET position = ? WHERE id = ?', [position, id])
};

const removeResponse = {
  run: (eventId, golferId) => run('DELETE FROM responses WHERE event_id = ? AND golfer_id = ?', [eventId, golferId])
};

module.exports = {
  initDb,
  addGolfer,
  getGolferByPhone,
  getAllActiveGolfers,
  updateGolferName,
  createEvent,
  getActiveEvent,
  closeEvent,
  getEventById,
  upsertResponse,
  getResponsesForEvent,
  getInCountForEvent,
  getNextWaitlistPosition,
  getResponseByGolferAndEvent,
  getFirstWaitlisted,
  updatePosition,
  removeResponse
};
