/**
 * Seed script to add golfers to the database
 * 
 * Usage: 
 *   1. Set GOLFERS env var as JSON array:
 *      GOLFERS='[{"name":"Jay","phone":"+15551234567"},{"name":"Mike","phone":"+15551234568"}]'
 *   2. Run: node src/seed.js
 * 
 * On Railway: Add GOLFERS to your environment variables, then run via Railway CLI:
 *   railway run node src/seed.js
 */

require('dotenv').config();
const db = require('./db');

function seed() {
  const golfersJson = process.env.GOLFERS;
  
  if (!golfersJson) {
    console.error('Error: GOLFERS environment variable not set.\n');
    console.log('Set it as a JSON array:');
    console.log('  GOLFERS=\'[{"name":"Jay","phone":"+15551234567"},{"name":"Mike","phone":"+15551234568"}]\'\n');
    console.log('Then run: node src/seed.js');
    process.exit(1);
  }
  
  let golfers;
  try {
    golfers = JSON.parse(golfersJson);
  } catch (e) {
    console.error('Error: GOLFERS is not valid JSON\n', e.message);
    process.exit(1);
  }
  
  if (!Array.isArray(golfers) || golfers.length === 0) {
    console.error('Error: GOLFERS must be a non-empty array');
    process.exit(1);
  }
  
  console.log('Seeding golfers...\n');
  
  for (const golfer of golfers) {
    if (!golfer.name || !golfer.phone) {
      console.log(`Skipped (missing name or phone): ${JSON.stringify(golfer)}`);
      continue;
    }
    
    try {
      db.addGolfer.run(golfer.name, golfer.phone);
      console.log(`Added: ${golfer.name} (${golfer.phone})`);
    } catch (error) {
      if (error.message.includes('UNIQUE constraint')) {
        console.log(`Skipped (already exists): ${golfer.name}`);
      } else {
        console.error(`Error adding ${golfer.name}:`, error.message);
      }
    }
  }
  
  console.log('\nDone. Current golfers:');
  const all = db.getAllActiveGolfers.all();
  all.forEach(g => console.log(`  - ${g.name}: ${g.phone}`));
  console.log(`\nTotal: ${all.length} golfers`);
}

seed();
