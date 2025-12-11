/**
 * API routes for the web app
 */
const express = require('express');
const router = express.Router();
const db = require('./db');
const { createEventAndNotify, recordResponse, generateSummary } = require('./events');
const { formatTime, formatDateForDisplay } = require('./parser');
const { sendSMS, sendToMany } = require('./sms');

const MANAGER_PHONES = (process.env.MANAGER_PHONE || '').split(',').map(p => p.trim());
const MAX_PLAYERS = 16;

/**
 * Verify if phone is authorized as manager
 */
router.post('/auth/verify', (req, res) => {
  const { phone } = req.body;
  const normalized = normalizePhone(phone);
  const authorized = MANAGER_PHONES.includes(normalized);
  res.json({ authorized });
});

/**
 * Get current event status with all response details
 */
router.get('/event/status', (req, res) => {
  const event = db.getActiveEvent.get();

  if (!event) {
    return res.json({ event: null });
  }

  const statusData = getEventStatusData(event);
  res.json(statusData);
});

/**
 * Get manager's response for current event
 */
router.get('/event/manager-status', (req, res) => {
  const phone = req.query.phone;
  const event = db.getActiveEvent.get();

  if (!event) {
    return res.json({ response: null });
  }

  const golfer = db.getGolferByPhone.get(phone);
  if (!golfer) {
    return res.json({ response: null });
  }

  const response = db.getResponseByGolferAndEvent.get(event.id, golfer.id);
  res.json({ response });
});

/**
 * Create a new event
 */
router.post('/event/create', async (req, res) => {
  try {
    const { date, course, times: timesRaw } = req.body;

    // Parse times from various formats
    const timesInput = timesRaw.split(/[,\/]/).map(t => t.trim()).filter(t => t);
    const times = timesInput.map(formatTime).filter(t => t);

    if (times.length === 0) {
      return res.json({ success: false, error: 'Invalid tee times format' });
    }

    // Format date to YYYY-MM-DD
    const dateObj = new Date(date + 'T12:00:00');
    const formattedDate = dateObj.toISOString().split('T')[0];

    const result = await createEventAndNotify(formattedDate, course, times);
    res.json({ success: true, eventId: result.eventId, notified: result.notified });
  } catch (err) {
    console.error('Create event error:', err);
    res.json({ success: false, error: 'Failed to create event' });
  }
});

/**
 * Close the current event
 */
router.post('/event/close', (req, res) => {
  const event = db.getActiveEvent.get();

  if (!event) {
    return res.json({ success: false, error: 'No active event to close' });
  }

  db.closeEvent.run(event.id);
  res.json({ success: true });
});

/**
 * Record manager's IN/OUT response
 */
router.post('/event/respond', async (req, res) => {
  try {
    const { phone, status } = req.body;

    const golfer = db.getGolferByPhone.get(phone);
    if (!golfer) {
      return res.json({ success: false, error: 'Manager not found as golfer' });
    }

    const event = db.getActiveEvent.get();
    if (!event) {
      return res.json({ success: false, error: 'No active event' });
    }

    const result = await recordResponse(golfer, event.id, status);
    res.json({ success: result.success, message: result.message });
  } catch (err) {
    console.error('Respond error:', err);
    res.json({ success: false, error: 'Failed to record response' });
  }
});

/**
 * Get event data for groupings (most recent closed event or active event)
 */
router.get('/event/for-groupings', (req, res) => {
  // First try active event
  let event = db.getActiveEvent.get();

  // If no active event, get most recent closed event
  if (!event) {
    event = db.db.prepare(
      "SELECT * FROM events WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1"
    ).get();
  }

  if (!event) {
    return res.json({ event: null });
  }

  const responses = db.getResponsesForEvent.all(event.id);
  const confirmed = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position);

  res.json({ event, confirmed });
});

/**
 * Send groupings via SMS
 */
router.post('/event/send-groupings', async (req, res) => {
  try {
    const { groupings } = req.body;

    // Get most recent event (active or closed)
    let event = db.getActiveEvent.get();
    if (!event) {
      event = db.db.prepare(
        "SELECT * FROM events WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1"
      ).get();
    }

    if (!event) {
      return res.json({ success: false, error: 'No event found' });
    }

    const dateStr = formatDateForDisplay(event.date);

    // Build the groupings message
    let message = `Golf ${dateStr} at ${event.course}\n\n`;

    const times = Object.keys(groupings).sort();
    times.forEach(time => {
      const players = (groupings[time] || []).filter(p => p);
      if (players.length > 0) {
        message += `${time}: ${players.join(', ')}\n`;
      }
    });

    message += '\nSee you on the course!';

    // Get all assigned players' phone numbers
    const allPlayers = new Set();
    Object.values(groupings).forEach(group => {
      group.filter(p => p).forEach(name => allPlayers.add(name));
    });

    // Look up phone numbers
    const allGolfers = db.getAllActiveGolfers.all();
    const phones = [];

    allPlayers.forEach(name => {
      const golfer = allGolfers.find(g => g.name === name);
      if (golfer) {
        phones.push(golfer.phone);
      }
    });

    if (phones.length === 0) {
      return res.json({ success: false, error: 'No valid phone numbers found' });
    }

    // Send messages
    const result = await sendToMany(phones, message);

    res.json({ success: true, sent: result.succeeded, failed: result.failed });
  } catch (err) {
    console.error('Send groupings error:', err);
    res.json({ success: false, error: 'Failed to send groupings' });
  }
});

/**
 * Get all active golfers
 */
router.get('/golfers', (req, res) => {
  const golfers = db.getAllActiveGolfers.all();
  res.json(golfers);
});

/**
 * Add a new golfer
 */
router.post('/golfers', (req, res) => {
  try {
    const { name, phone } = req.body;
    const normalized = normalizePhone(phone);

    if (!normalized) {
      return res.json({ success: false, error: 'Invalid phone number' });
    }

    // Check if phone already exists
    const existing = db.getGolferByPhone.get(normalized);
    if (existing) {
      return res.json({ success: false, error: 'Phone number already registered' });
    }

    db.addGolfer.run(name, normalized);
    res.json({ success: true });
  } catch (err) {
    console.error('Add golfer error:', err);
    res.json({ success: false, error: 'Failed to add golfer' });
  }
});

/**
 * Update a golfer
 */
router.put('/golfers/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone } = req.body;
    const normalized = normalizePhone(phone);

    if (!normalized) {
      return res.json({ success: false, error: 'Invalid phone number' });
    }

    // Check if phone already exists for different golfer
    const existing = db.getGolferByPhone.get(normalized);
    if (existing && existing.id !== parseInt(id)) {
      return res.json({ success: false, error: 'Phone number already in use' });
    }

    db.updateGolferPhone.run(normalized, id);
    db.updateGolferName.run(name, normalized);

    res.json({ success: true });
  } catch (err) {
    console.error('Update golfer error:', err);
    res.json({ success: false, error: 'Failed to update golfer' });
  }
});

/**
 * Remove (deactivate) a golfer
 */
router.delete('/golfers/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.deactivateGolfer.run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete golfer error:', err);
    res.json({ success: false, error: 'Failed to remove golfer' });
  }
});

// Helper functions
function normalizePhone(input) {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function getEventStatusData(event) {
  const responses = db.getResponsesForEvent.all(event.id);
  const allGolfers = db.getAllActiveGolfers.all();

  const confirmed = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position);

  const waitlist = responses
    .filter(r => r.status === 'in' && r.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position);

  const out = responses.filter(r => r.status === 'out');

  const respondedIds = new Set(responses.map(r => r.golfer_id));
  const noResponse = allGolfers.filter(g => !respondedIds.has(g.id));

  return { event, confirmed, waitlist, out, noResponse };
}

module.exports = router;
