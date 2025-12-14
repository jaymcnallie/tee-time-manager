const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'teetimes.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS golfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1,
    tier TEXT DEFAULT 'preferred',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    course TEXT,
    times TEXT NOT NULL,
    max_players INTEGER DEFAULT 16,
    status TEXT DEFAULT 'open',
    backup_notified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

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
  );

  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    host_golfer_id INTEGER NOT NULL,
    name TEXT DEFAULT 'Guest',
    position INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (host_golfer_id) REFERENCES golfers(id)
  );
`);

// Migration: Add tier column to existing golfers table if it doesn't exist
try {
  db.exec(`ALTER TABLE golfers ADD COLUMN tier TEXT DEFAULT 'preferred'`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add backup_notified_at column to existing events table if it doesn't exist
try {
  db.exec(`ALTER TABLE events ADD COLUMN backup_notified_at TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Golfer queries
const addGolfer = db.prepare('INSERT OR IGNORE INTO golfers (name, phone) VALUES (?, ?)');
const addGolferWithTier = db.prepare('INSERT OR IGNORE INTO golfers (name, phone, tier) VALUES (?, ?, ?)');
const getGolferByPhone = db.prepare('SELECT * FROM golfers WHERE phone = ?');
const getGolferById = db.prepare('SELECT * FROM golfers WHERE id = ?');
const getAllActiveGolfers = db.prepare('SELECT * FROM golfers WHERE active = 1');
const getAllPreferredGolfers = db.prepare("SELECT * FROM golfers WHERE active = 1 AND tier = 'preferred'");
const getAllBackupGolfers = db.prepare("SELECT * FROM golfers WHERE active = 1 AND tier = 'backup'");
const updateGolferName = db.prepare('UPDATE golfers SET name = ? WHERE phone = ?');
const updateGolferTier = db.prepare('UPDATE golfers SET tier = ? WHERE id = ?');

// Event queries
const createEvent = db.prepare('INSERT INTO events (date, course, times) VALUES (?, ?, ?)');
const getActiveEvent = db.prepare("SELECT * FROM events WHERE status = 'open' ORDER BY created_at DESC LIMIT 1");
const closeEvent = db.prepare("UPDATE events SET status = 'closed' WHERE id = ?");
const getEventById = db.prepare('SELECT * FROM events WHERE id = ?');
const markBackupNotified = db.prepare("UPDATE events SET backup_notified_at = CURRENT_TIMESTAMP WHERE id = ?");
const deactivateGolfer = db.prepare('UPDATE golfers SET active = 0 WHERE id = ?');
const updateGolferPhone = db.prepare('UPDATE golfers SET phone = ? WHERE id = ?');

// Response queries
const upsertResponse = db.prepare(`
  INSERT INTO responses (event_id, golfer_id, status, position, responded_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(event_id, golfer_id) DO UPDATE SET
    status = excluded.status,
    position = excluded.position,
    responded_at = CURRENT_TIMESTAMP
`);

const getResponsesForEvent = db.prepare(`
  SELECT r.*, g.name, g.phone
  FROM responses r
  JOIN golfers g ON r.golfer_id = g.id
  WHERE r.event_id = ?
  ORDER BY r.position ASC, r.responded_at ASC
`);

const getInCountForEvent = db.prepare(`
  SELECT COUNT(*) as count FROM responses
  WHERE event_id = ? AND status = 'in'
`);

const getNextWaitlistPosition = db.prepare(`
  SELECT COALESCE(MAX(position), 16) + 1 as next_pos
  FROM responses
  WHERE event_id = ? AND status = 'in' AND position > 16
`);

const getResponseByGolferAndEvent = db.prepare(`
  SELECT * FROM responses
  WHERE event_id = ? AND golfer_id = ?
`);

const getFirstWaitlisted = db.prepare(`
  SELECT r.*, g.name, g.phone
  FROM responses r
  JOIN golfers g ON r.golfer_id = g.id
  WHERE r.event_id = ? AND r.status = 'in' AND r.position > 16
  ORDER BY r.position ASC
  LIMIT 1
`);

const updatePosition = db.prepare('UPDATE responses SET position = ? WHERE id = ?');

const removeResponse = db.prepare('DELETE FROM responses WHERE event_id = ? AND golfer_id = ?');

// Guest queries
const addGuest = db.prepare('INSERT INTO guests (event_id, host_golfer_id, name, position) VALUES (?, ?, ?, ?)');

const getGuestsForEvent = db.prepare(`
  SELECT g.*, h.name as host_name
  FROM guests g
  JOIN golfers h ON g.host_golfer_id = h.id
  WHERE g.event_id = ?
  ORDER BY g.position ASC
`);

const getGuestsByHost = db.prepare(`
  SELECT * FROM guests
  WHERE event_id = ? AND host_golfer_id = ?
`);

const updateGuestName = db.prepare('UPDATE guests SET name = ? WHERE id = ?');

const updateGuestPosition = db.prepare('UPDATE guests SET position = ? WHERE id = ?');

const deleteGuest = db.prepare('DELETE FROM guests WHERE id = ?');

const deleteGuestsByHost = db.prepare('DELETE FROM guests WHERE event_id = ? AND host_golfer_id = ?');

const getGuestById = db.prepare('SELECT * FROM guests WHERE id = ?');

const getGuestCountForEvent = db.prepare(`
  SELECT COUNT(*) as count FROM guests WHERE event_id = ?
`);

module.exports = {
  db,
  addGolfer,
  addGolferWithTier,
  getGolferByPhone,
  getGolferById,
  getAllActiveGolfers,
  getAllPreferredGolfers,
  getAllBackupGolfers,
  updateGolferName,
  updateGolferPhone,
  updateGolferTier,
  deactivateGolfer,
  createEvent,
  getActiveEvent,
  closeEvent,
  getEventById,
  markBackupNotified,
  upsertResponse,
  getResponsesForEvent,
  getInCountForEvent,
  getNextWaitlistPosition,
  getResponseByGolferAndEvent,
  getFirstWaitlisted,
  updatePosition,
  removeResponse,
  // Guest exports
  addGuest,
  getGuestsForEvent,
  getGuestsByHost,
  updateGuestName,
  updateGuestPosition,
  deleteGuest,
  deleteGuestsByHost,
  getGuestById,
  getGuestCountForEvent
};
