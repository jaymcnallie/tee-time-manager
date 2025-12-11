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
 * In test mode, doesn't send SMS notifications
 */
router.post('/event/create', async (req, res) => {
  try {
    const { date, course, times: timesRaw, testMode } = req.body;

    // Parse times from various formats
    const timesInput = timesRaw.split(/[,\/]/).map(t => t.trim()).filter(t => t);
    const times = timesInput.map(formatTime).filter(t => t);

    if (times.length === 0) {
      return res.json({ success: false, error: 'Invalid tee times format' });
    }

    // Format date to YYYY-MM-DD
    const dateObj = new Date(date + 'T12:00:00');
    const formattedDate = dateObj.toISOString().split('T')[0];

    if (testMode) {
      // In test mode, create event without sending SMS
      const result = await createEventWithoutNotify(formattedDate, course, times);
      res.json({ success: true, eventId: result.eventId, notified: result.notified });
    } else {
      const result = await createEventAndNotify(formattedDate, course, times);
      res.json({ success: true, eventId: result.eventId, notified: result.notified });
    }
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
 * Simulate a golfer's response (test mode only)
 */
router.post('/event/simulate-response', async (req, res) => {
  try {
    const { golferId, status } = req.body;

    const event = db.getActiveEvent.get();
    if (!event) {
      return res.json({ success: false, error: 'No active event' });
    }

    // Get golfer by ID
    const golfer = db.db.prepare('SELECT * FROM golfers WHERE id = ?').get(golferId);
    if (!golfer) {
      return res.json({ success: false, error: 'Golfer not found' });
    }

    // Record the response without sending SMS (simulated)
    const result = await recordResponseSilent(golfer, event.id, status);
    res.json({ success: result.success, message: result.message });
  } catch (err) {
    console.error('Simulate response error:', err);
    res.json({ success: false, error: 'Failed to simulate response' });
  }
});

/**
 * Generate random responses for all golfers (test mode)
 */
router.post('/event/random-responses', async (req, res) => {
  try {
    const event = db.getActiveEvent.get();
    if (!event) {
      return res.json({ success: false, error: 'No active event' });
    }

    const golfers = db.getAllActiveGolfers.all();
    let inCount = 0;
    let outCount = 0;

    for (const golfer of golfers) {
      // Random: 70% chance IN, 30% chance OUT
      const status = Math.random() < 0.7 ? 'in' : 'out';
      await recordResponseSilent(golfer, event.id, status);

      if (status === 'in') inCount++;
      else outCount++;
    }

    res.json({ success: true, inCount, outCount });
  } catch (err) {
    console.error('Random responses error:', err);
    res.json({ success: false, error: 'Failed to generate random responses' });
  }
});

/**
 * Clear all responses for the current event (test mode)
 */
router.post('/event/clear-responses', (req, res) => {
  try {
    const event = db.getActiveEvent.get();
    if (!event) {
      return res.json({ success: false, error: 'No active event' });
    }

    // Delete all responses for this event
    db.db.prepare('DELETE FROM responses WHERE event_id = ?').run(event.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Clear responses error:', err);
    res.json({ success: false, error: 'Failed to clear responses' });
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
  const guests = db.getGuestsForEvent.all(event.id);

  // Combine confirmed golfers and guests
  const confirmedGolfers = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => ({ ...r, type: 'golfer' }));

  const confirmedGuests = guests
    .filter(g => g.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(g => ({ ...g, type: 'guest' }));

  const confirmed = [...confirmedGolfers, ...confirmedGuests]
    .sort((a, b) => a.position - b.position);

  res.json({ event, confirmed });
});

/**
 * Send groupings via SMS
 * In test mode, doesn't actually send SMS
 */
router.post('/event/send-groupings', async (req, res) => {
  try {
    const { groupings, testMode } = req.body;

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

    if (testMode) {
      // In test mode, just return success without sending
      console.log('[TEST MODE] Would send groupings to:', phones);
      console.log('[TEST MODE] Message:', message);
      res.json({ success: true, sent: phones.length, failed: 0 });
    } else {
      // Send messages
      const result = await sendToMany(phones, message);
      res.json({ success: true, sent: result.succeeded, failed: result.failed });
    }
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

/**
 * Get all guests for current event
 */
router.get('/guests', (req, res) => {
  let event = db.getActiveEvent.get();
  if (!event) {
    event = db.db.prepare(
      "SELECT * FROM events WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1"
    ).get();
  }

  if (!event) {
    return res.json([]);
  }

  const guests = db.getGuestsForEvent.all(event.id);
  res.json(guests);
});

/**
 * Update a guest's name
 */
router.put('/guests/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.json({ success: false, error: 'Name is required' });
    }

    db.updateGuestName.run(name.trim(), id);
    res.json({ success: true });
  } catch (err) {
    console.error('Update guest error:', err);
    res.json({ success: false, error: 'Failed to update guest' });
  }
});

/**
 * Delete a guest
 */
router.delete('/guests/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.deleteGuest.run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete guest error:', err);
    res.json({ success: false, error: 'Failed to delete guest' });
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
  const guests = db.getGuestsForEvent.all(event.id);
  const allGolfers = db.getAllActiveGolfers.all();

  // Confirmed golfers
  const confirmedGolfers = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => ({ ...r, type: 'golfer' }));

  // Confirmed guests
  const confirmedGuests = guests
    .filter(g => g.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(g => ({ ...g, type: 'guest' }));

  const confirmed = [...confirmedGolfers, ...confirmedGuests]
    .sort((a, b) => a.position - b.position);

  // Waitlist golfers
  const waitlistGolfers = responses
    .filter(r => r.status === 'in' && r.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => ({ ...r, type: 'golfer' }));

  // Waitlist guests
  const waitlistGuests = guests
    .filter(g => g.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(g => ({ ...g, type: 'guest' }));

  const waitlist = [...waitlistGolfers, ...waitlistGuests]
    .sort((a, b) => a.position - b.position);

  const out = responses.filter(r => r.status === 'out');

  const respondedIds = new Set(responses.map(r => r.golfer_id));
  const noResponse = allGolfers.filter(g => !respondedIds.has(g.id));

  return { event, confirmed, waitlist, out, noResponse, guests };
}

/**
 * Create event without sending SMS notifications (for test mode)
 */
async function createEventWithoutNotify(date, course, times) {
  // Close any existing open events
  const existingEvent = db.getActiveEvent.get();
  if (existingEvent) {
    db.closeEvent.run(existingEvent.id);
  }

  // Create new event
  const timesStr = JSON.stringify(times);
  const result = db.createEvent.run(date, course, timesStr);
  const eventId = result.lastInsertRowid;

  // Count how many golfers would be notified
  const golfers = db.getAllActiveGolfers.all();

  console.log(`[TEST MODE] Event ${eventId} created for ${date}, would notify ${golfers.length} golfers`);
  return { eventId, notified: golfers.length };
}

/**
 * Record response without sending SMS (for simulated responses)
 */
async function recordResponseSilent(golfer, eventId, status) {
  const event = db.getEventById.get(eventId);
  if (!event) {
    return { success: false, message: 'No active event' };
  }

  // Check current response
  const existingResponse = db.getResponseByGolferAndEvent.get(eventId, golfer.id);
  const wasIn = existingResponse?.status === 'in';

  if (status === 'in') {
    // Get current count of confirmed players
    const { count } = db.getInCountForEvent.get(eventId);

    if (existingResponse?.status === 'in') {
      // Already in, no change needed
      const pos = existingResponse.position;
      if (pos <= MAX_PLAYERS) {
        return { success: true, message: `Already in (#${pos} of ${MAX_PLAYERS})`, position: pos };
      } else {
        return { success: true, message: `Already on waitlist #${pos - MAX_PLAYERS}`, position: pos };
      }
    }

    let position;
    if (count < MAX_PLAYERS) {
      position = count + 1;
    } else {
      const { next_pos } = db.getNextWaitlistPosition.get(eventId);
      position = next_pos;
    }

    db.upsertResponse.run(eventId, golfer.id, 'in', position);

    if (position <= MAX_PLAYERS) {
      return { success: true, message: `In (#${position} of ${MAX_PLAYERS})`, position };
    } else {
      const waitlistPos = position - MAX_PLAYERS;
      return { success: true, message: `Waitlist #${waitlistPos}`, position };
    }

  } else if (status === 'out') {
    const previousPosition = existingResponse?.position;

    db.upsertResponse.run(eventId, golfer.id, 'out', null);

    // If they were in the top 16, bump up waitlist (silently)
    if (wasIn && previousPosition && previousPosition <= MAX_PLAYERS) {
      await bumpWaitlistSilent(eventId);
    }

    return { success: true, message: "Out" };
  }

  return { success: false, message: 'Invalid status' };
}

/**
 * Bump waitlist without sending SMS notification
 */
async function bumpWaitlistSilent(eventId) {
  const waitlisted = db.getFirstWaitlisted.get(eventId);
  if (!waitlisted) {
    return null;
  }

  // Find the next available position in top 16
  const responses = db.getResponsesForEvent.all(eventId);
  const takenPositions = new Set(
    responses
      .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
      .map(r => r.position)
  );

  let newPosition = 1;
  while (takenPositions.has(newPosition) && newPosition <= MAX_PLAYERS) {
    newPosition++;
  }

  if (newPosition <= MAX_PLAYERS) {
    db.updatePosition.run(newPosition, waitlisted.id);
    console.log(`[SILENT] Bumped ${waitlisted.name} from waitlist to position ${newPosition}`);
    return waitlisted;
  }

  return null;
}

module.exports = router;
