// Tee Time Manager - Web App
const API_BASE = '';

// State
let currentPhone = localStorage.getItem('managerPhone') || '';
let currentEvent = null;
let golfers = [];
let groupings = {}; // { teeTime: [player1, player2, ...] }
let testMode = localStorage.getItem('testMode') === 'true';
let eventResponses = {}; // Track responses in current view { golferId: { status, position } }

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard');
const phoneInput = document.getElementById('phone-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();

  // Restore test mode state
  const testModeCheckbox = document.getElementById('test-mode-checkbox');
  testModeCheckbox.checked = testMode;
  updateTestModeUI();

  if (currentPhone) {
    verifyAndLogin(currentPhone);
  }
});

function setupEventListeners() {
  // Login
  loginBtn.addEventListener('click', () => handleLogin());
  phoneInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  logoutBtn.addEventListener('click', handleLogout);

  // Test mode toggle
  document.getElementById('test-mode-checkbox').addEventListener('change', toggleTestMode);

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Event actions
  document.getElementById('refresh-status-btn').addEventListener('click', loadEventStatus);
  document.getElementById('close-event-btn').addEventListener('click', closeEvent);
  document.getElementById('create-event-form').addEventListener('submit', createEvent);

  // Manager response
  document.getElementById('manager-in-btn').addEventListener('click', () => managerRespond('in'));
  document.getElementById('manager-out-btn').addEventListener('click', () => managerRespond('out'));

  // Test mode: simulate responses
  document.getElementById('random-responses-btn').addEventListener('click', randomResponses);
  document.getElementById('clear-responses-btn').addEventListener('click', clearAllResponses);

  // Golfers
  document.getElementById('add-golfer-form').addEventListener('submit', addGolfer);

  // Edit modal
  document.getElementById('cancel-edit-btn').addEventListener('click', closeEditModal);
  document.getElementById('delete-golfer-btn').addEventListener('click', deleteGolfer);
  document.getElementById('edit-golfer-form').addEventListener('submit', updateGolfer);

  // Groupings
  document.getElementById('send-groupings-btn').addEventListener('click', sendGroupings);

  // Set default date to next Sunday
  const dateInput = document.getElementById('event-date');
  const today = new Date();
  const daysUntilSunday = (7 - today.getDay()) % 7 || 7;
  const nextSunday = new Date(today);
  nextSunday.setDate(today.getDate() + daysUntilSunday);
  dateInput.value = nextSunday.toISOString().split('T')[0];
}

// Test Mode
function toggleTestMode() {
  testMode = document.getElementById('test-mode-checkbox').checked;
  localStorage.setItem('testMode', testMode);
  updateTestModeUI();

  if (testMode) {
    showToast('Test Mode enabled - No SMS will be sent', 'success');
  } else {
    showToast('Test Mode disabled - SMS will be sent', '');
  }
}

function updateTestModeUI() {
  const banner = document.getElementById('test-mode-banner');
  const simulateSection = document.getElementById('simulate-responses');

  if (testMode) {
    banner.classList.remove('hidden');
    if (currentEvent) {
      simulateSection.classList.remove('hidden');
      loadSimulateList();
    }
  } else {
    banner.classList.add('hidden');
    simulateSection.classList.add('hidden');
  }
}

async function loadSimulateList() {
  if (!currentEvent || !testMode) return;

  const listEl = document.getElementById('simulate-golfer-list');

  try {
    // Get all golfers and current responses
    const [golfersRes, statusRes] = await Promise.all([
      fetch(`${API_BASE}/api/golfers`),
      fetch(`${API_BASE}/api/event/status`)
    ]);

    const allGolfers = await golfersRes.json();
    const statusData = await statusRes.json();

    // Build response map
    eventResponses = {};
    if (statusData.confirmed) {
      statusData.confirmed.forEach(r => {
        eventResponses[r.golfer_id] = { status: 'in', position: r.position };
      });
    }
    if (statusData.waitlist) {
      statusData.waitlist.forEach(r => {
        eventResponses[r.golfer_id] = { status: 'in', position: r.position };
      });
    }
    if (statusData.out) {
      statusData.out.forEach(r => {
        eventResponses[r.golfer_id] = { status: 'out', position: null };
      });
    }

    listEl.innerHTML = allGolfers.map(g => {
      const response = eventResponses[g.id];
      const isIn = response?.status === 'in';
      const isOut = response?.status === 'out';
      let statusText = '';

      if (isIn) {
        statusText = response.position <= 16
          ? `#${response.position} of 16`
          : `Waitlist #${response.position - 16}`;
      } else if (isOut) {
        statusText = 'Out';
      }

      return `
        <div class="simulate-item" data-golfer-id="${g.id}">
          <span class="golfer-name">${escapeHtml(g.name)}</span>
          <div class="response-btns">
            <button class="sim-btn in-btn ${isIn ? 'active' : ''}"
                    onclick="simulateResponse(${g.id}, 'in')">IN</button>
            <button class="sim-btn out-btn ${isOut ? 'active' : ''}"
                    onclick="simulateResponse(${g.id}, 'out')">OUT</button>
          </div>
          <span class="response-status">${statusText}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading simulate list:', err);
    listEl.innerHTML = '<p class="error">Failed to load golfers</p>';
  }
}

async function simulateResponse(golferId, status) {
  try {
    const res = await fetch(`${API_BASE}/api/event/simulate-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ golferId, status })
    });
    const data = await res.json();

    if (data.success) {
      // Refresh the UI
      await loadEventStatus();
      loadSimulateList();
    } else {
      showToast(data.error || 'Failed to simulate response', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Simulate response error:', err);
  }
}

async function randomResponses() {
  if (!currentEvent) return;

  try {
    const res = await fetch(`${API_BASE}/api/event/random-responses`, {
      method: 'POST'
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Generated ${data.inCount} IN, ${data.outCount} OUT responses`, 'success');
      await loadEventStatus();
      loadSimulateList();
    } else {
      showToast(data.error || 'Failed to generate responses', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Random responses error:', err);
  }
}

async function clearAllResponses() {
  if (!currentEvent) return;

  if (!confirm('Clear all responses for this event?')) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/event/clear-responses`, {
      method: 'POST'
    });
    const data = await res.json();

    if (data.success) {
      showToast('All responses cleared', 'success');
      await loadEventStatus();
      loadSimulateList();
    } else {
      showToast(data.error || 'Failed to clear responses', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Clear responses error:', err);
  }
}

// Login/Logout
async function handleLogin() {
  const phone = normalizePhone(phoneInput.value);
  if (!phone) {
    loginError.textContent = 'Please enter a valid phone number';
    return;
  }
  await verifyAndLogin(phone);
}

async function verifyAndLogin(phone) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();

    if (data.authorized) {
      currentPhone = phone;
      localStorage.setItem('managerPhone', phone);
      showDashboard();
    } else {
      loginError.textContent = 'Phone number not authorized as manager';
      localStorage.removeItem('managerPhone');
    }
  } catch (err) {
    loginError.textContent = 'Connection error. Please try again.';
    console.error('Login error:', err);
  }
}

function handleLogout() {
  currentPhone = '';
  localStorage.removeItem('managerPhone');
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
  phoneInput.value = '';
  loginError.textContent = '';
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  loadEventStatus();
  loadGolfers();
}

// Tabs
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`${tabName}-tab`).classList.remove('hidden');

  if (tabName === 'groupings') {
    loadGroupings();
  }
}

// Event Management
async function loadEventStatus() {
  const eventInfo = document.getElementById('event-info');
  const eventActions = document.getElementById('event-actions');
  const simulateSection = document.getElementById('simulate-responses');

  try {
    const res = await fetch(`${API_BASE}/api/event/status`);
    const data = await res.json();

    if (data.event) {
      currentEvent = data.event;
      renderEventStatus(data);
      eventActions.classList.remove('hidden');

      // Check manager's current response
      loadManagerResponse();

      // Show simulate section in test mode
      if (testMode) {
        simulateSection.classList.remove('hidden');
        loadSimulateList();
      }
    } else {
      currentEvent = null;
      eventInfo.innerHTML = '<p>No active event. Create one below.</p>';
      eventActions.classList.add('hidden');
      simulateSection.classList.add('hidden');
    }
  } catch (err) {
    eventInfo.innerHTML = '<p class="error">Failed to load event status</p>';
    console.error('Load event error:', err);
  }
}

function renderEventStatus(data) {
  const { event, confirmed, waitlist, out, noResponse } = data;
  const times = JSON.parse(event.times);

  const dateStr = formatDateDisplay(event.date);

  let html = `
    <div class="event-header">${dateStr} at ${event.course}</div>
    <div class="event-times">Tee times: ${times.join(', ')}</div>
    <div class="event-status-badge">Status: ${event.status.toUpperCase()}</div>
    <div class="event-summary">
      <div class="summary-section">
        <div class="summary-label in">IN (${confirmed.length})</div>
        <div class="summary-names">${confirmed.map(r => r.name).join(', ') || 'None'}</div>
      </div>
  `;

  if (waitlist.length > 0) {
    html += `
      <div class="summary-section">
        <div class="summary-label waitlist">WAITLIST (${waitlist.length})</div>
        <div class="summary-names">${waitlist.map(r => r.name).join(', ')}</div>
      </div>
    `;
  }

  if (out.length > 0) {
    html += `
      <div class="summary-section">
        <div class="summary-label out">OUT (${out.length})</div>
        <div class="summary-names">${out.map(r => r.name).join(', ')}</div>
      </div>
    `;
  }

  if (noResponse.length > 0) {
    html += `
      <div class="summary-section">
        <div class="summary-label no-response">NO RESPONSE (${noResponse.length})</div>
        <div class="summary-names">${noResponse.map(g => g.name).join(', ')}</div>
      </div>
    `;
  }

  html += '</div>';
  document.getElementById('event-info').innerHTML = html;
}

async function loadManagerResponse() {
  try {
    const res = await fetch(`${API_BASE}/api/event/manager-status?phone=${encodeURIComponent(currentPhone)}`);
    const data = await res.json();

    const statusEl = document.getElementById('manager-response-status');
    if (data.response) {
      if (data.response.status === 'in') {
        const pos = data.response.position;
        if (pos <= 16) {
          statusEl.textContent = `You're IN (#${pos} of 16)`;
        } else {
          statusEl.textContent = `You're on waitlist #${pos - 16}`;
        }
      } else {
        statusEl.textContent = "You're OUT for this event";
      }
    } else {
      statusEl.textContent = "You haven't responded yet";
    }
  } catch (err) {
    console.error('Error loading manager response:', err);
  }
}

async function createEvent(e) {
  e.preventDefault();

  const date = document.getElementById('event-date').value;
  const course = document.getElementById('event-course').value;
  const timesRaw = document.getElementById('event-times').value;

  const resultEl = document.getElementById('create-event-result');
  resultEl.textContent = 'Creating event...';
  resultEl.className = 'result';

  try {
    const res = await fetch(`${API_BASE}/api/event/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, course, times: timesRaw, testMode })
    });
    const data = await res.json();

    if (data.success) {
      const notifyMsg = testMode
        ? `Event created! (Test mode: ${data.notified} golfers would be notified)`
        : `Event created! Notified ${data.notified} golfers.`;
      resultEl.textContent = notifyMsg;
      resultEl.className = 'result success';
      showToast(notifyMsg, 'success');

      // Reset groupings for new event
      groupings = {};

      loadEventStatus();

      // Clear form
      document.getElementById('event-course').value = '';
      document.getElementById('event-times').value = '';
    } else {
      resultEl.textContent = data.error || 'Failed to create event';
      resultEl.className = 'result error';
    }
  } catch (err) {
    resultEl.textContent = 'Connection error';
    resultEl.className = 'result error';
    console.error('Create event error:', err);
  }
}

async function closeEvent() {
  if (!confirm('Close this event? This will prevent further responses via SMS.')) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/event/close`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('Event closed', 'success');
      loadEventStatus();
    } else {
      showToast(data.error || 'Failed to close event', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Close event error:', err);
  }
}

async function managerRespond(status) {
  try {
    const res = await fetch(`${API_BASE}/api/event/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: currentPhone, status })
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message, 'success');
      loadEventStatus();
    } else {
      showToast(data.error || 'Failed to record response', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Respond error:', err);
  }
}

// Golfer Management
async function loadGolfers() {
  const listEl = document.getElementById('golfer-list');
  const countEl = document.getElementById('golfer-count');

  try {
    const res = await fetch(`${API_BASE}/api/golfers`);
    golfers = await res.json();

    countEl.textContent = `(${golfers.length})`;

    if (golfers.length === 0) {
      listEl.innerHTML = '<p>No golfers registered yet.</p>';
      return;
    }

    listEl.innerHTML = golfers.map(g => `
      <div class="golfer-item">
        <div class="golfer-info">
          <div class="golfer-name">${escapeHtml(g.name)}</div>
          <div class="golfer-phone">${formatPhoneDisplay(g.phone)}</div>
        </div>
        <button class="golfer-edit-btn" onclick="openEditModal(${g.id})">Edit</button>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = '<p class="error">Failed to load golfers</p>';
    console.error('Load golfers error:', err);
  }
}

async function addGolfer(e) {
  e.preventDefault();

  const name = document.getElementById('golfer-name').value.trim();
  const phone = normalizePhone(document.getElementById('golfer-phone').value);
  const resultEl = document.getElementById('add-golfer-result');

  if (!phone) {
    resultEl.textContent = 'Invalid phone number';
    resultEl.className = 'result error';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/golfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone })
    });
    const data = await res.json();

    if (data.success) {
      resultEl.textContent = `Added ${name}`;
      resultEl.className = 'result success';
      document.getElementById('golfer-name').value = '';
      document.getElementById('golfer-phone').value = '';
      loadGolfers();

      // Refresh simulate list if in test mode
      if (testMode && currentEvent) {
        loadSimulateList();
      }
    } else {
      resultEl.textContent = data.error || 'Failed to add golfer';
      resultEl.className = 'result error';
    }
  } catch (err) {
    resultEl.textContent = 'Connection error';
    resultEl.className = 'result error';
    console.error('Add golfer error:', err);
  }
}

function openEditModal(golferId) {
  const golfer = golfers.find(g => g.id === golferId);
  if (!golfer) return;

  document.getElementById('edit-golfer-id').value = golferId;
  document.getElementById('edit-golfer-name').value = golfer.name;
  document.getElementById('edit-golfer-phone').value = formatPhoneDisplay(golfer.phone);
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function updateGolfer(e) {
  e.preventDefault();

  const id = document.getElementById('edit-golfer-id').value;
  const name = document.getElementById('edit-golfer-name').value.trim();
  const phone = normalizePhone(document.getElementById('edit-golfer-phone').value);

  if (!phone) {
    showToast('Invalid phone number', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/golfers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Golfer updated', 'success');
      closeEditModal();
      loadGolfers();
    } else {
      showToast(data.error || 'Failed to update', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Update golfer error:', err);
  }
}

async function deleteGolfer() {
  const id = document.getElementById('edit-golfer-id').value;
  const name = document.getElementById('edit-golfer-name').value;

  if (!confirm(`Remove ${name} from the group?`)) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/golfers/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.success) {
      showToast('Golfer removed', 'success');
      closeEditModal();
      loadGolfers();
    } else {
      showToast(data.error || 'Failed to remove', 'error');
    }
  } catch (err) {
    showToast('Connection error', 'error');
    console.error('Delete golfer error:', err);
  }
}

// Groupings
async function loadGroupings() {
  const noEventEl = document.getElementById('groupings-no-event');
  const containerEl = document.getElementById('groupings-container');

  try {
    const res = await fetch(`${API_BASE}/api/event/for-groupings`);
    const data = await res.json();

    if (!data.event) {
      noEventEl.classList.remove('hidden');
      containerEl.classList.add('hidden');
      return;
    }

    noEventEl.classList.add('hidden');
    containerEl.classList.remove('hidden');

    const { event, confirmed } = data;
    const times = JSON.parse(event.times);

    document.getElementById('groupings-event-title').textContent =
      `Groupings for ${formatDateDisplay(event.date)}`;
    document.getElementById('groupings-event-info').textContent =
      `${event.course} - ${confirmed.length} confirmed players`;

    // Initialize groupings if empty or for different event
    if (Object.keys(groupings).length === 0) {
      times.forEach(time => {
        groupings[time] = [];
      });
    }

    renderPlayersPool(confirmed);
    renderFoursomes(times, confirmed);
    updateGroupingsPreview(times, event);

  } catch (err) {
    console.error('Load groupings error:', err);
    noEventEl.innerHTML = '<p class="error">Failed to load groupings data</p>';
    noEventEl.classList.remove('hidden');
    containerEl.classList.add('hidden');
  }
}

function renderPlayersPool(confirmed) {
  const poolEl = document.getElementById('players-pool');
  const assignedPlayers = new Set(Object.values(groupings).flat());

  const unassigned = confirmed.filter(p => !assignedPlayers.has(p.name));

  poolEl.innerHTML = unassigned.map(p => `
    <div class="player-chip" draggable="true" data-player="${escapeHtml(p.name)}"
         ondragstart="handleDragStart(event)">${escapeHtml(p.name)}</div>
  `).join('') || '<span style="color: var(--text-light)">All players assigned</span>';
}

function renderFoursomes(times, confirmed) {
  const container = document.getElementById('foursomes-container');

  container.innerHTML = times.map((time, idx) => `
    <div class="foursome-card">
      <div class="foursome-header">
        <h4>Foursome ${idx + 1}</h4>
        <span class="foursome-time">${time}</span>
      </div>
      <div class="foursome-slots" data-time="${time}">
        ${[0, 1, 2, 3].map(slot => {
          const player = groupings[time]?.[slot];
          return `
            <div class="foursome-slot ${player ? 'filled' : ''}"
                 data-time="${time}" data-slot="${slot}"
                 ondragover="handleDragOver(event)"
                 ondragleave="handleDragLeave(event)"
                 ondrop="handleDrop(event)">
              ${player ? `
                <span class="slot-player">${escapeHtml(player)}</span>
                <button class="slot-remove" onclick="removeFromSlot('${time}', ${slot})">×</button>
              ` : `
                <span class="slot-placeholder">Drop player here</span>
              `}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  updateSendButton();
}

function handleDragStart(e) {
  e.dataTransfer.setData('text/plain', e.target.dataset.player);
  e.target.style.opacity = '0.5';
}

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');

  const player = e.dataTransfer.getData('text/plain');
  const time = e.currentTarget.dataset.time;
  const slot = parseInt(e.currentTarget.dataset.slot);

  // Check if slot is empty
  if (groupings[time][slot]) {
    return;
  }

  // Remove from any existing slot
  Object.keys(groupings).forEach(t => {
    const idx = groupings[t].indexOf(player);
    if (idx !== -1) {
      groupings[t].splice(idx, 1);
    }
  });

  // Ensure array has enough slots
  while (groupings[time].length <= slot) {
    groupings[time].push(null);
  }

  groupings[time][slot] = player;

  // Re-render
  loadGroupings();
}

function removeFromSlot(time, slot) {
  if (groupings[time]) {
    groupings[time][slot] = null;
    // Clean up trailing nulls
    while (groupings[time].length > 0 && !groupings[time][groupings[time].length - 1]) {
      groupings[time].pop();
    }
  }
  loadGroupings();
}

function updateGroupingsPreview(times, event) {
  const previewEl = document.getElementById('groupings-preview');
  const dateStr = formatDateDisplay(event.date);

  let preview = `Golf ${dateStr} at ${event.course}\n\n`;

  times.forEach((time, idx) => {
    const players = (groupings[time] || []).filter(p => p);
    preview += `${time}: ${players.length > 0 ? players.join(', ') : '(empty)'}\n`;
  });

  previewEl.textContent = preview;
}

function updateSendButton() {
  const btn = document.getElementById('send-groupings-btn');
  const hasGroupings = Object.values(groupings).some(g => g.filter(p => p).length > 0);
  btn.disabled = !hasGroupings;

  // Update button text based on test mode
  btn.textContent = testMode
    ? 'Preview Send (Test Mode)'
    : 'Send Groupings to All Players';
}

async function sendGroupings() {
  const confirmMsg = testMode
    ? 'Preview sending groupings? (No SMS will be sent in test mode)'
    : 'Send groupings to all assigned players via SMS?';

  if (!confirm(confirmMsg)) {
    return;
  }

  const resultEl = document.getElementById('send-groupings-result');
  resultEl.textContent = testMode ? 'Simulating send...' : 'Sending...';
  resultEl.className = 'result';

  try {
    const res = await fetch(`${API_BASE}/api/event/send-groupings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupings, testMode })
    });
    const data = await res.json();

    if (data.success) {
      const msg = testMode
        ? `Test mode: Would send to ${data.sent} players`
        : `Sent groupings to ${data.sent} players!`;
      resultEl.textContent = msg;
      resultEl.className = 'result success';
      showToast(msg, 'success');
    } else {
      resultEl.textContent = data.error || 'Failed to send';
      resultEl.className = 'result error';
    }
  } catch (err) {
    resultEl.textContent = 'Connection error';
    resultEl.className = 'result error';
    console.error('Send groupings error:', err);
  }
}

// Utility functions
function normalizePhone(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function formatPhoneDisplay(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function formatDateDisplay(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// Make functions available globally for onclick handlers
window.openEditModal = openEditModal;
window.removeFromSlot = removeFromSlot;
window.handleDragStart = handleDragStart;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDrop = handleDrop;
window.simulateResponse = simulateResponse;
