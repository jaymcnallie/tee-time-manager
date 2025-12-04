require('dotenv').config();

console.log('Starting app...');
console.log('TELNYX_API_KEY exists:', !!process.env.TELNYX_API_KEY);
console.log('MANAGER_PHONE:', process.env.MANAGER_PHONE);

const express = require('express');
console.log('Express loaded');

const db = require('./db');
console.log('DB loaded');

const { parseManagerAnnouncement, parseGolferResponse } = require('./parser');
console.log('Parser loaded');

const { createEventAndNotify, recordResponse, forwardToManager } = require('./events');
console.log('Events loaded');

const { sendSMS } = require('./sms');
console.log('SMS loaded');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const MANAGER_PHONE = process.env.MANAGER_PHONE;

/**
 * Main SMS webhook - handles all incoming messages from Telnyx
 */
app.post('/sms', async (req, res) => {
  // Telnyx sends data in a different format
  const payload = req.body.data?.payload || req.body;
  const from = payload.from?.phone_number || payload.from;
  const body = payload.text || payload.body;
  
  console.log(`SMS from ${from}: ${body}`);
  
  let responseText = '';
  
  try {
    // Check if this is from the manager
    if (from === MANAGER_PHONE) {
      responseText = await handleManagerMessage(body);
    } else {
      responseText = await handleGolferMessage(from, body);
    }
  } catch (error) {
    console.error('Error handling SMS:', error);
    responseText = 'Something went wrong. Please try again.';
  }
  
  // Send reply via API (Telnyx doesn't use TwiML)
  if (responseText) {
    try {
      await sendSMS(from, responseText);
    } catch (err) {
      console.error('Failed to send reply:', err);
    }
  }
  
  // Acknowledge receipt to Telnyx
  res.status(200).json({ success: true });
});

/**
 * Handle messages from the group manager
 */
async function handleManagerMessage(body) {
  // Try to parse as announcement
  const announcement = parseManagerAnnouncement(body);
  
  if (announcement) {
    const { date, course, times } = announcement;
    const { eventId, notified } = await createEventAndNotify(date, course, times);
    return `Event created for ${date}. Invite sent to ${notified} golfers.`;
  }
  
  // Check for admin commands
  const command = body.trim().toLowerCase();
  
  if (command === 'status') {
    const event = db.getActiveEvent.get();
    if (event) {
      const { generateSummary } = require('./events');
      return generateSummary(event.id);
    } else {
      return 'No active event.';
    }
  }
  
  if (command === 'closed') {
    const event = db.getActiveEvent.get();
    if (event) {
      const { generateSummary } = require('./events');
      const summary = generateSummary(event.id);
      db.closeEvent.run(event.id);
      return summary;
    } else {
      return 'No active event to close.';
    }
  }
  
  if (command === 'list') {
    const golfers = db.getAllActiveGolfers.all();
    const names = golfers.map(g => g.name).join(', ');
    return `Golfers (${golfers.length}): ${names}`;
  }
  
  if (command.startsWith('add ')) {
    // Format: "add Name 5551234567"
    const match = body.match(/^add\s+(.+?)\s+(\+?1?\d{10,11})$/i);
    if (match) {
      const name = match[1].trim();
      let phone = match[2].replace(/\D/g, '');
      if (phone.length === 10) phone = '1' + phone;
      phone = '+' + phone;
      
      db.addGolfer.run(name, phone);
      return `Added ${name} (${phone})`;
    } else {
      return 'Format: add Name 5551234567';
    }
  }
  
  if (command === 'help') {
    return 'Commands:\n' +
      '• Golf announcement to create event\n' +
      '• STATUS - current event summary\n' +
      '• CLOSED - send summary & close event\n' +
      '• LIST - all golfers\n' +
      '• ADD Name Phone - add golfer';
  }
  
  return 'Unrecognized command. Reply HELP for options.';
}

/**
 * Handle messages from golfers
 */
async function handleGolferMessage(from, body) {
  // Get or create golfer
  let golfer = db.getGolferByPhone.get(from);
  
  if (!golfer) {
    // Unknown number - could add auto-registration or just ignore
    return 'Your number is not registered. Contact the group manager.';
  }
  
  // Check if there's an active event
  const event = db.getActiveEvent.get();
  
  if (!event) {
    // No active event - forward to manager
    await forwardToManager(golfer, body);
    return 'No active event. Your message has been forwarded to the group manager.';
  }
  
  // Check if we're past Friday (forward mode)
  const now = new Date();
  const dayOfWeek = now.getDay();
  
  // If it's Saturday (6) or Sunday (0) for this event's week, forward to manager
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    await forwardToManager(golfer, body);
    return 'Response window closed. Your message has been forwarded to the group manager.';
  }
  
  // Try to parse response
  const response = parseGolferResponse(body);
  
  if (!response) {
    return 'Reply IN or OUT';
  }
  
  // Record the response
  const result = await recordResponse(golfer, event.id, response);
  return result.message;
}

/**
 * SMS Consent page for verification
 */
app.get('/consent', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>SMS Consent - Sunday Golf Group</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6;">
        <h1>SMS Consent Record</h1>
        <p>All members of the Sunday Golf Group have provided verbal consent to receive SMS messages regarding weekly tee time coordination from this service.</p>
        <h2>Details</h2>
        <ul>
          <li><strong>Group:</strong> Sunday Golf Group</li>
          <li><strong>Consent collected by:</strong> Jay McNallie</li>
          <li><strong>Date:</strong> November 30, 2025</li>
          <li><strong>Number of members:</strong> 20</li>
        </ul>
        <h2>Purpose</h2>
        <p>Messages sent through this service are limited to:</p>
        <ul>
          <li>Weekly tee time announcements (sent Wednesdays)</li>
          <li>RSVP confirmations</li>
          <li>Waitlist notifications</li>
        </ul>
        <h2>Opt-Out</h2>
        <p>Members may reply <strong>STOP</strong> at any time to unsubscribe from all messages.</p>
        <h2>Contact</h2>
        <p>For questions about this service, contact Jay McNallie.</p>
      </body>
    </html>
  `);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ensure data directory exists
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tee Time Manager running on port ${PORT}`);
  console.log(`Webhook URL: https://tee-time-manager-production.up.railway.app/sms`);
});
