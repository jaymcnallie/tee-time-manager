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
 * Record a golfer's response
 */
async function recordResponse(golfer, eventId, status) {
  const event = db.getEventById.get(eventId);
  if (!event) {
    return { success: false, message: 'No active event' };
  }
  
  // Check current response
  const existingResponse = db.getResponseByGolferAndEvent.get(eventId, golfer.id);
  const wasIn = existingResponse?.status === 'in';
  const wasOut = existingResponse?.status === 'out';
  
  if (status === 'in') {
    // Get current count of confirmed players
    const { count } = db.getInCountForEvent.get(eventId);
    
    if (existingResponse?.status === 'in') {
      // Already in, no change needed
      const pos = existingResponse.position;
      if (pos <= MAX_PLAYERS) {
        return { success: true, message: `You're already in (#${pos} of ${MAX_PLAYERS})`, position: pos };
      } else {
        return { success: true, message: `You're already on waitlist #${pos - MAX_PLAYERS}`, position: pos };
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
      return { success: true, message: `You're in (#${position} of ${MAX_PLAYERS})`, position };
    } else {
      const waitlistPos = position - MAX_PLAYERS;
      return { success: true, message: `Waitlist #${waitlistPos}. We'll text you if a spot opens.`, position };
    }
    
  } else if (status === 'out') {
    const previousPosition = existingResponse?.position;
    
    db.upsertResponse.run(eventId, golfer.id, 'out', null);
    
    // If they were in the top 16, bump up waitlist
    if (wasIn && previousPosition && previousPosition <= MAX_PLAYERS) {
      await bumpWaitlist(eventId);
    }
    
    return { success: true, message: "Got it, you're out." };
  }
  
  return { success: false, message: 'Invalid status' };
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
  const allGolfers = db.getAllActiveGolfers.all();
  
  const confirmed = responses
    .filter(r => r.status === 'in' && r.position <= MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => r.name);
  
  const waitlist = responses
    .filter(r => r.status === 'in' && r.position > MAX_PLAYERS)
    .sort((a, b) => a.position - b.position)
    .map(r => r.name);
  
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
  forwardToManager
};
