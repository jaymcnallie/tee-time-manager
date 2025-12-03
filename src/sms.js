const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const fromNumber = process.env.TELNYX_PHONE_NUMBER;

async function sendSMS(to, body) {
  try {
    const response = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TELNYX_API_KEY}`
      },
      body: JSON.stringify({
        from: fromNumber,
        to: to,
        text: body
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.errors?.[0]?.detail || 'Failed to send SMS');
    }
    
    console.log(`SMS sent to ${to}: ${data.data.id}`);
    return data;
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
