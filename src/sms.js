const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const fromNumber = process.env.TWILIO_PHONE_NUMBER;

async function sendSMS(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to
    });
    console.log(`SMS sent to ${to}: ${message.sid}`);
    return message;
  } catch (error) {
    console.error(`Failed to send SMS to ${to}:`, error.message);
    throw error;
  }
}

async function sendToMany(phoneNumbers, body) {
  const results = await Promise.allSettled(
    phoneNumbers.map(phone => sendSMS(phone, body))
  );
  
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  
  console.log(`Bulk SMS: ${succeeded} sent, ${failed} failed`);
  return { succeeded, failed, results };
}

module.exports = { sendSMS, sendToMany };
