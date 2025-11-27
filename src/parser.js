/**
 * Parses manager's tee time announcement
 * Expected format:
 *   Golf 11-30-2025
 *   Red
 *   808/816/824/832
 *   In or out
 */
function parseManagerAnnouncement(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
  
  if (lines.length < 3) {
    return null;
  }
  
  // Line 1: "Golf MM-DD-YYYY" or "Golf M-D-YYYY"
  const dateMatch = lines[0].match(/^golf\s+(\d{1,2}-\d{1,2}-\d{4})/i);
  if (!dateMatch) {
    return null;
  }
  
  const dateParts = dateMatch[1].split('-');
  const date = `${dateParts[2]}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}`; // YYYY-MM-DD
  
  // Line 2: Course name
  const course = lines[1];
  
  // Line 3: Times like "808/816/824/832"
  const timesRaw = lines[2].split('/').map(t => t.trim());
  const times = timesRaw.map(formatTime).filter(t => t);
  
  if (times.length === 0) {
    return null;
  }
  
  return { date, course, times };
}

/**
 * Convert "808" or "1015" to "8:08 AM" or "10:15 AM"
 */
function formatTime(raw) {
  // Remove any colons first
  const cleaned = raw.replace(':', '');
  
  if (!/^\d{3,4}$/.test(cleaned)) {
    return null;
  }
  
  let hours, minutes;
  if (cleaned.length === 3) {
    hours = parseInt(cleaned[0], 10);
    minutes = cleaned.slice(1);
  } else {
    hours = parseInt(cleaned.slice(0, 2), 10);
    minutes = cleaned.slice(2);
  }
  
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours > 12 ? hours - 12 : hours || 12;
  
  return `${displayHours}:${minutes} ${period}`;
}

/**
 * Parse golfer response: "in", "out", "I'm in", "yes", "no", etc.
 */
function parseGolferResponse(text) {
  const cleaned = text.toLowerCase().trim();
  
  // Check for "in" responses
  if (/^(in|i'm in|im in|yes|y|count me in|i am in)$/i.test(cleaned)) {
    return 'in';
  }
  
  // Check for "out" responses
  if (/^(out|i'm out|im out|no|n|count me out|i am out|can't make it|cant make it)$/i.test(cleaned)) {
    return 'out';
  }
  
  return null;
}

/**
 * Format date for display: "Sunday 11/30"
 */
function formatDateForDisplay(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = days[date.getDay()];
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${dayName} ${month}/${day}`;
}

module.exports = {
  parseManagerAnnouncement,
  parseGolferResponse,
  formatTime,
  formatDateForDisplay
};
