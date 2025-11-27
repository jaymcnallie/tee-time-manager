# Tee Time Manager

SMS-based tee time management for golf groups. Manager sends tee times, golfers respond, system tracks capacity and waitlist.

## How It Works

1. **Wednesday**: Manager texts tee times → service parses and invites all golfers
2. **Wed-Fri**: Golfers reply IN or OUT, first 16 confirmed, rest waitlisted
3. **Friday (or whenever)**: Manager texts CLOSED → receives summary, event closes
4. **After close**: Late messages forwarded directly to manager

## Setup

### 1. Twilio Account

1. Create account at [twilio.com](https://twilio.com)
2. Buy a phone number (~$1.15/month)
3. Note your Account SID and Auth Token from the console

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxx
TWILIO_PHONE_NUMBER=+15551234567  # Your Twilio number
MANAGER_PHONE=+15559876543        # Your personal number
```

### 3. Add Golfers

Edit `src/seed.js` with your golfers:

```javascript
const GOLFERS = [
  { name: 'Jay', phone: '+15551234567' },
  { name: 'Mike', phone: '+15551234568' },
  // ... all 20 golfers
];
```

Run the seed script:

```bash
npm run seed
```

Or add golfers via SMS by texting `ADD Name 5551234567` from the manager number.

### 4. Deploy to Railway

1. Create account at [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard
4. Note your deployed URL (e.g., `https://tee-time-manager-production.up.railway.app`)

### 5. Configure Twilio Webhook

1. Go to Twilio Console → Phone Numbers → Your Number
2. Set "When a message comes in" webhook to:
   ```
   https://your-railway-url.up.railway.app/sms
   ```
3. Method: POST

## Manager Commands

Text these from the manager phone number:

| Command | Description |
|---------|-------------|
| Golf announcement | Create event and notify golfers |
| `STATUS` | Get current event summary (doesn't close) |
| `CLOSED` | Send summary & close event |
| `LIST` | Show all registered golfers |
| `ADD Name Phone` | Add a new golfer |
| `HELP` | Show available commands |

### Announcement Format

```
Golf 11-30-2025
Red
808/816/824/832
In or out
```

## Golfer Responses

Valid responses (case-insensitive):
- **In**: `in`, `I'm in`, `yes`, `y`, `count me in`
- **Out**: `out`, `I'm out`, `no`, `n`, `can't make it`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sms` | POST | Twilio webhook |
| `/health` | GET | Health check |

## Local Development

```bash
npm install
npm run dev
```

Use [ngrok](https://ngrok.com) to expose local server for Twilio webhooks:

```bash
ngrok http 3000
```

Then set the ngrok URL as your Twilio webhook.

## Costs

- Twilio number: ~$1.15/month
- SMS: ~$0.0079 per message sent/received
- For 20 golfers, ~$3-5/month total
- Railway: Free tier works fine (no cron needed)

## File Structure

```
tee-time-manager/
├── src/
│   ├── index.js    # Express server & webhooks
│   ├── db.js       # SQLite database
│   ├── sms.js      # Twilio SMS functions
│   ├── parser.js   # Message parsing
│   ├── events.js   # Event management logic
│   └── seed.js     # Add golfers script
├── data/
│   └── teetimes.db # SQLite database (auto-created)
├── .env.example
├── package.json
└── README.md
```
