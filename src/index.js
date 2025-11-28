require('dotenv').config();

console.log('Starting app...');
console.log('TWILIO_ACCOUNT_SID exists:', !!process.env.TWILIO_ACCOUNT_SID);
console.log('TWILIO_AUTH_TOKEN exists:', !!process.env.TWILIO_AUTH_TOKEN);
console.log('MANAGER_PHONE:', process.env.MANAGER_PHONE);

const express = require('express');
console.log('Express loaded');

const { MessagingResponse } = require('twilio').twiml;
console.log('Twilio loaded');

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
 * Main SMS webhook - handles all incoming messages
 */
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  
  console.log(`SMS from ${from}: ${body}`);
  
  const twiml = new MessagingResponse();
  
  try {
    // Check if this is from the manager
    if (from === MANAGER_PHONE) {
      await handleManagerMessage(body, twiml);
    } else {
      await handleGolferMessage(from, body, twiml);
    }
  } catch (error) {
    console.error('Error handling SMS:', error);
    twiml.message('Something went wrong. Please try again.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Handle messages from the group manager
 */
async function handleManagerMessage(body, twiml) {
  // Try to parse as announcement
  const announcement = parseManagerAnnouncement(body);
  
  if (announcement) {
    const { date, course, times } = announcement;
    const { eventId, notified } = await createEventAndNotify(date, course, times);
    twiml.message(`Event created for ${date}. Invite sent to ${notified} golfers.`);
    return;
  }
  
  // Check for admin commands
  const command = body.trim().toLowerCase();
  
  if (command === 'status') {
    const event = db.getActiveEvent.get();
    if (event) {
      const { generateSummary } = require('./events');
      const summary = generateSummary(event.id);
      twiml.message(summary);
    } else {
      twiml.message('No active event.');
    }
    return;
  }
  
  if (command === 'closed') {
    const event = db.getActiveEvent.get();
    if (event) {
      const { generateSummary } = require('./events');
      const summary = generateSummary(event.id);
      db.closeEvent.run(event.id);
      twiml.message(summary);
    } else {
      twiml.message('No active event to close.');
    }
    return;
  }
  
  if (command === 'list') {
    const golfers = db.getAllActiveGolfers.all();
    const names = golfers.map(g => g.name).join(', ');
    twiml.message(`Golfers (${golfers.length}): ${names}`);
    return;
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
      twiml.message(`Added ${name} (${phone})`);
    } else {
      twiml.message('Format: add Name 5551234567');
    }
    return;
  }
  
  if (command === 'help') {
    twiml.message(
      'Commands:\n' +
      '• Golf announcement to create event\n' +
      '• STATUS - current event summary\n' +
      '• CLOSED - send summary & close event\n' +
      '• LIST - all golfers\n' +
      '• ADD Name Phone - add golfer'
    );
    return;
  }
  
  twiml.message('Unrecognized command. Reply HELP for options.');
}

/**
 * Handle messages from golfers
 */
async function handleGolferMessage(from, body, twiml) {
  // Get or create golfer
  let golfer = db.getGolferByPhone.get(from);
  
  if (!golfer) {
    // Unknown number - could add auto-registration or just ignore
    twiml.message('Your number is not registered. Contact the group manager.');
    return;
  }
  
  // Check if there's an active event
  const event = db.getActiveEvent.get();
  
  if (!event) {
    // No active event - forward to manager
    await forwardToManager(golfer, body);
    twiml.message('No active event. Your message has been forwarded to the group manager.');
    return;
  }
  
  // Check if we're past Friday (forward mode)
  const eventDate = new Date(event.date);
  const now = new Date();
  const dayOfWeek = now.getDay();
  
  // If it's Saturday (6) or Sunday (0) for this event's week, forward to manager
  // Simple check: if event is this week's Sunday and today is Sat/Sun
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    await forwardToManager(golfer, body);
    twiml.message('Response window closed. Your message has been forwarded to the group manager.');
    return;
  }
  
  // Try to parse response
  const response = parseGolferResponse(body);
  
  if (!response) {
    twiml.message('Reply IN or OUT');
    return;
  }
  
  // Record the response
  const result = await recordResponse(golfer, event.id, response);
  twiml.message(result.message);
}

/**
 * SMS Consent page for Twilio verification
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
          <li><strong>Consent collected by:</strong> [Your Name]</li>
          <li><strong>Date:</strong> [Date]</li>
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
        <p>For questions about this service, contact Jay McNallie at jaymcnallie@gmail.com..</p>
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
