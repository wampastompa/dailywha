const fs = require('fs');
const readline = require('readline/promises');

const CATEGORY_ORDER = [
  'Gear',
  'Home',
  'Health',
  'Outside',
  'Play',
  'Read',
  'Fashion',
  'Gourmet',
];

const FIELDS = [
  { key: 'url', label: 'URL' },
  { key: 'title', label: 'Title' },
  { key: 'image', label: 'Image (URL)' },
  { key: 'price', label: 'Price' },
  { key: 'store', label: 'Store' },
  { key: 'why', label: 'Why (short note)' },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadLinksJson() {
  const raw = fs.readFileSync('deals/links.json', 'utf8');
  const cfg = JSON.parse(raw);
  assert(cfg && typeof cfg === 'object', 'deals/links.json must be an object');
  assert(cfg.categories && typeof cfg.categories === 'object', 'deals/links.json must have categories');

  for (const cat of CATEGORY_ORDER) {
    const arr = cfg.categories[cat];
    assert(Array.isArray(arr), `Category ${cat} must be an array`);
    assert(arr.length === 4, `Category ${cat} must have exactly 4 items`);
    for (let i = 0; i < 4; i++) {
      const it = arr[i];
      assert(it && typeof it === 'object', `${cat}[${i}] must be an object`);
      for (const f of FIELDS) {
        if (typeof it[f.key] !== 'string') it[f.key] = '';
      }
    }
  }

  return cfg;
}

function isoDateChicago() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function printHeader() {
  console.log('');
  console.log('DailyWha Deals Wizard');
  console.log('---------------------');
  console.log('Tip: press Enter to keep the existing value.');
  console.log('Type /skip to skip the rest of this deal.');
  console.log('Type /cat to skip the rest of this category.');
  console.log('Type /quit to exit without saving.');
  console.log('');
}

async function main() {
  const cfg = loadLinksJson();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  printHeader();

  const start = await rl.question('Start wizard now? (y/N): ');
  if (!/^y(es)?$/i.test(start.trim())) {
    rl.close();
    console.log('Cancelled.');
    return;
  }

  let quit = false;

  for (const cat of CATEGORY_ORDER) {
    if (quit) break;
    console.log('');
    console.log(`=== ${cat.toUpperCase()} ===`);

    const items = cfg.categories[cat];
    let skipCat = false;

    for (let idx = 0; idx < 4; idx++) {
      if (quit || skipCat) break;
      console.log('');
      console.log(`Deal ${idx + 1} of 4`);

      const it = items[idx];
      let skipDeal = false;

      for (const f of FIELDS) {
        if (quit || skipCat || skipDeal) break;
        const current = (it[f.key] || '').trim();
        const prompt = `${f.label}${current ? ` [${current}]` : ''}: `;
        const ansRaw = await rl.question(prompt);
        const ans = ansRaw.trim();

        if (ans === '/quit') { quit = true; break; }
        if (ans === '/cat') { skipCat = true; break; }
        if (ans === '/skip') { skipDeal = true; break; }

        if (ans !== '') it[f.key] = ans;
      }
    }
  }

  if (quit) {
    rl.close();
    console.log('\nExited without saving.');
    return;
  }

  cfg.updated_at = isoDateChicago();

  console.log('');
  const confirm = await rl.question('Write changes to deals/links.json? (y/N): ');
  rl.close();

  if (!/^y(es)?$/i.test(confirm.trim())) {
    console.log('Not saved.');
    return;
  }

  fs.writeFileSync('deals/links.json', JSON.stringify(cfg, null, 2) + '\n');
  console.log('Saved: deals/links.json');
  console.log('Next: run the “DailyWha Deals Update” workflow to generate captions.');
}

main().catch((err) => {
  console.error('Wizard error:', err);
  process.exit(1);
});

