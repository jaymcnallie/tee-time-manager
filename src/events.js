const db = require('./db');
const { sendSMS, sendToMany } = require('./sms');
const { formatDateForDisplay } = require('./parser');

const MAX_PLAYERS = 16;

/**
 * Create a new golf event and notify all golfers
 */
async function createEventAndNotify(date, course, times) {
  // Close any existing open events
  const existingEvent = db.getActiveEvent.get();
  if (existingEvent) {
    db.closeEvent.run(existingEvent.id);
  }

  // Create new event
  const timesStr = JSON.stringify(times);
  const result = db.createEvent.run(date, course, timesStr);
  const eventId = result.lastInsertRowid;

  // Build announcement message
  const displayDate = formatDateForDisplay(date);
  const timesDisplay = times.join(', ');
  const message = `Golf ${displayDate} at ${course}\nTee times: ${timesDisplay}\nFirst 16 in. Reply IN or OUT.`;

  // Get all active golfers and send
  const golfers = db.getAllActiveGolfers.all();
  const phones = golfers.map(g => g.phone);

  if (phones.length > 0) {
    await sendToMany(phones, message);
  }

  console.log(`Event ${eventId} created for ${date}, notified ${phones.length} golfers`);
  return { eventId, notified: phones.length };
}

/**
 * Record a golfer's response (with optional guests)
 * @param {Object} golfer - The golfer object
 * @param {number} eventId - The event ID
 * @param {string} status - 'in' or 'out'
 * @param {number} guestCount - Number of guests (default 0)
 */
async function recordResponse(golfer, eventId, status, guestCount = 0) {
  const event = db.getEventById.get(eventId);
  if (!event) {
    return { success: false, message: 'No active event' };
  }

  // Check current response
  const existingResponse = db.getResponseByGolferAndEvent.get(eventId, golfer.id);
  const wasIn = existingResponse?.status === 'in';

  // Get existing guests for this golfer
  const existingGuests = db.getGuestsByHost.all(eventId, golfer.id);

  if (status === 'in') {
    // Get current count of confirmed players (including guests)
    const { count: responseCount } = db.getInCountForEvent.get(eventId);
    const { count: guestTotalCount } = db.getGuestCountForEvent.get(eventId);
    const totalConfirmed = responseCount + guestTotalCount;

    if (existingResponse?.status === 'in' && guestCount === 0 && existingGuests.length === 0) {
      // Already in with no guest changes
      const pos = existingResponse.position;
      if (pos <= MAX_PLAYERS) {
        return { success: true, message: `You're already in (#${pos} of ${MAX_PLAYERS})`, position: pos };
      } else {
        return { success: true, message: `You're already on waitlist #${pos - MAX_PLAYERS}`, position: pos };
      }
    }

    let position;
    let message;

    if (existingResponse?.status === 'in') {
      // Already in, just update guests
      position = existingResponse.position;
    } else {
      // New response - assign position
      if (totalConfirmed < MAX_PLAYERS) {
        position = totalConfirmed + 1;
      } else {
        const { next_pos } = db.getNextWaitlistPosition.get(eventId);
        position = next_pos;
      }
      db.upsertResponse.run(eventId, golfer.id, 'in', position);
    }

    // Handle guest changes
    if (guestCount > existingGuests.length) {
      // Add more guests
      const guestsToAdd = guestCount - existingGuests.length;
      for (let i = 0; i < guestsToAdd; i++) {
        // Calculate guest position
        const currentTotal = getTotalConfirmedCount(eventId);
        let guestPosition;
        if (currentTotal < MAX_PLAYERS) {
          guestPosition = currentTotal + 1;
        } else {
          guestPosition = currentTotal + 1; // Goes to waitlist
        }

        const guestName = `${golfer.name}'s Guest`;
        db.addGuest.run(eventId, golfer.id, guestName, guestPosition);
      }
    } else if (guestCount < existingGuests.length) {
      // Remove excess guests (remove from the end)
      const guestsToRemove = existingGuests.length - guestCount;
      for (let i = 0; i < guestsToRemove; i++) {
        const guestToRemove = existingGuests[existingGuests.length - 1 - i];
        db.deleteGuest.run(guestToRemove.id);
      }
    }

    // Build response message
    if (position <= MAX_PLAYERS) {
      if (guestCount > 0) {
        message = `You're in (#${position} of ${MAX_PLAYERS}) with ${guestCount} guest${guestCount > 1 ? 's' : ''}`;
      } else {
        message = `You're in (#${position} of ${MAX_PLAYERS})`;
      }
    } else {
      const waitlistPos = position - MAX_PLAYERS;
      if (guestCount > 0) {
        message = `Waitlist #${waitlistPos} with ${guestCount} guest${guestCount > 1 ? 's' : ''}. We'll text you if spots open.`;
      } else {
        message = `Waitlist #${waitlistPos}. We'll text you if a spot opens.`;
      }
    }

    return { success: true, message, position, guests: guestCount };

  } else if (status === 'out') {
    const previousPosition = existingResponse?.position;

    db.upsertResponse.run(eventId, golfer.id, 'out', null);

    // Remove any guests this golfer had
    db.deleteGuestsByHost.run(eventId, golfer.id);

    // If they were in the top 16, bump up waitlist
    if (wasIn && previousPosition && previousPosition <= MAX_PLAYERS) {
      await bumpWaitlist(eventId);
    }

    return { success: true, message: "Got it, you're out." };
  }

  return { success: false, message: 'Invalid status' };
}

/**
 * Get total confirmed count (responses + guests)
 */
function getTotalConfirmedCount(eventId) {
  const { count: responseCount } = db.getInCountForEvent.get(eventId);
  const { count: guestCount } = db.getGuestCountForEvent.get(eventId);
  return responseCount + guestCount;
}

/**
 * Bump first waitlisted person into confirmed spot
 */
async function bumpWaitlist(eventId) {
  const waitlisted = db.getFirstWaitlisted.get(eventId);
  if (!waitlisted) {
    return null;
  }

  // Find the next available position in top 16
  const responses = db.getResponsesForEvent.all(eventId);
  const guests = db.getGuestsForEvent.all(eventId);

  const takenPositions = new Set([
    ...responses
      .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
      .map(r => r.position),
    ...guests
      .filter(g => g.position <= MAX_PLAYERS)
      .map(g => g.position)
  ]);

  let newPosition = 1;
  while (takenPositions.has(newPosition) && newPosition <= MAX_PLAYERS) {
    newPosition++;
  }

  if (newPosition <= MAX_PLAYERS) {
    db.updatePosition.run(newPosition, waitlisted.id);

    // Notify the bumped-up golfer
    await sendSMS(
      waitlisted.phone,
      `Spot opened—you're now in (#${newPosition} of ${MAX_PLAYERS})`
    );

    console.log(`Bumped ${waitlisted.name} from waitlist to position ${newPosition}`);
    return waitlisted;
  }

  return null;
}

/**
 * Generate Friday summary for manager
 */
function generateSummary(eventId) {
  const event = db.getEventById.get(eventId);
  if (!event) {
    return null;
  }

  const responses = db.getResponsesForEvent.all(eventId);
  const guests = db.getGuestsForEvent.all(eventId);
  const allGolfers = db.getAllActiveGolfers.all();

  // Combine confirmed golfers and guests
  const confirmedGolfers = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => r.name);

  const confirmedGuests = guests
    .filter(g => g.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(g => g.name);

  const confirmed = [...confirmedGolfers, ...confirmedGuests].sort();

  // Waitlist
  const waitlistGolfers = responses
    .filter(r => r.status === 'in' && r.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => r.name);

  const waitlistGuests = guests
    .filter(g => g.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(g => g.name);

  const waitlist = [...waitlistGolfers, ...waitlistGuests];

  const out = responses
    .filter(r => r.status === 'out')
    .map(r => r.name);

  const respondedIds = new Set(responses.map(r => r.golfer_id));
  const noResponse = allGolfers
    .filter(g => !respondedIds.has(g.id))
    .map(g => g.name);

  const displayDate = formatDateForDisplay(event.date);
  const times = JSON.parse(event.times);

  let summary = `Golf ${displayDate} ${event.course} - ${confirmed.length} confirmed\n`;
  summary += `Times: ${times.join(', ')}\n\n`;
  summary += `IN (${confirmed.length}): ${confirmed.join(', ') || 'None'}\n\n`;

  if (waitlist.length > 0) {
    summary += `WAITLIST (${waitlist.length}): ${waitlist.join(', ')}\n\n`;
  }

  if (out.length > 0) {
    summary += `OUT (${out.length}): ${out.join(', ')}\n\n`;
  }

  if (noResponse.length > 0) {
    summary += `NO RESPONSE (${noResponse.length}): ${noResponse.join(', ')}`;
  }

  return summary.trim();
}

/**
 * Send Friday summary to manager
 */
async function sendFridaySummary() {
  const event = db.getActiveEvent.get();
  if (!event) {
    console.log('No active event for Friday summary');
    return;
  }

  const summary = generateSummary(event.id);
  if (summary) {
    await sendSMS(process.env.MANAGER_PHONE, summary);
    console.log('Friday summary sent to manager');
  }

  // Close the event after summary
  db.closeEvent.run(event.id);
}

/**
 * Forward a message to the manager (for post-Friday messages)
 */
async function forwardToManager(golfer, message) {
  const forwardedMsg = `From ${golfer.name}: ${message}`;
  await sendSMS(process.env.MANAGER_PHONE, forwardedMsg);
}

module.exports = {
  createEventAndNotify,
  recordResponse,
  bumpWaitlist,
  generateSummary,
  sendFridaySummary,
  forwardToManager,
  getTotalConfirmedCount
};
