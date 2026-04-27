const https = require('https');
const fs = require('fs');

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

function readGroqApiKey() {
  let k = String(process.env.GROQ_API_KEY || '');
  k = k.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  k = k.replace(/^Bearer\s+/i, '').trim();
  return k;
}

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ error: { message: 'Non-JSON response from ' + hostname + path }, _raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadLinks() {
  const raw = fs.readFileSync('deals/links.json', 'utf8');
  const cfg = JSON.parse(raw);
  assert(cfg && typeof cfg === 'object', 'links.json must be an object');
  assert(cfg.categories && typeof cfg.categories === 'object', 'links.json must contain categories');

  for (const cat of CATEGORY_ORDER) {
    const items = cfg.categories[cat];
    assert(Array.isArray(items), `Category ${cat} must be an array`);
    assert(items.length === 4, `Category ${cat} must have exactly 4 items`);
    items.forEach((it, i) => {
      assert(it && typeof it === 'object', `${cat}[${i}] must be an object`);
      ['url', 'title', 'image', 'price', 'store', 'why'].forEach((k) => {
        assert(typeof it[k] === 'string', `${cat}[${i}].${k} must be a string`);
      });
    });
  }

  return cfg;
}

function buildItemId(cat, idx) {
  return `${cat}:${idx}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(items) {
  // items: [{id, url, title, price, store, why}]
  return `You are the editor of “DailyWha? Deals”, a daily deals page.\n\n` +
    `Write warm, personalized captions for product deals.\n\n` +
    `Rules:\n` +
    `- Output ONLY valid JSON. No markdown, no backticks, no commentary.\n` +
    `- For each item, return: {\"id\": string, \"caption\": string}.\n` +
    `- caption must be 1–2 sentences, friendly, specific, and not salesy-hype.\n` +
    `- Use the provided title/price/store/why; do NOT invent specs.\n` +
    `- If why mentions a coupon/code, naturally include it.\n\n` +
    `Items JSON:\n` +
    `${JSON.stringify(items, null, 2)}\n\n` +
    `Return JSON array of {\"id\",\"caption\"} in the same order.`;
}

function cleanJsonText(s) {
  return String(s || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function captionsForChunk(groqKey, items) {
  const prompt = buildPrompt(items);
  const res = await httpsPost(
    'api.groq.com',
    '/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      Authorization: 'Bearer ' + groqKey,
    }
  );

  if (!res || res.error) {
    const err = res && res.error ? res.error : res;
    console.error('Groq API error:', err);
    throw new Error('Groq request failed');
  }

  const content = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
  assert(content, 'Groq response missing choices[0].message.content');

  const cleaned = cleanJsonText(content);
  const parsed = JSON.parse(cleaned);
  assert(Array.isArray(parsed), 'Groq output must be a JSON array');
  parsed.forEach((x, i) => {
    assert(x && typeof x === 'object', `Groq output item ${i} must be an object`);
    assert(typeof x.id === 'string', `Groq output item ${i}.id must be a string`);
    assert(typeof x.caption === 'string', `Groq output item ${i}.caption must be a string`);
  });
  return parsed;
}

async function main() {
  const groqKey = readGroqApiKey();
  const cfg = loadLinks();

  const all = [];
  for (const cat of CATEGORY_ORDER) {
    cfg.categories[cat].forEach((it, idx) => {
      all.push({
        id: buildItemId(cat, idx),
        category: cat,
        idx,
        url: it.url,
        title: it.title,
        image: it.image,
        price: it.price,
        store: it.store,
        why: it.why,
      });
    });
  }

  // Guard: allow empty placeholders, but if any are empty, skip captioning and write a stub today.json.
  const hasEmpty = all.some((it) => !it.url || !it.title || !it.image || !it.price || !it.store || !it.why);
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });

  const captionsById = {};
  if (!hasEmpty) {
    assert(groqKey, 'Missing GROQ_API_KEY');
    // 32 items total; chunk into 4 calls of 8 items for reliability.
    const chunks = chunk(all.map(({ id, url, title, price, store, why }) => ({ id, url, title, price, store, why })), 8);
    for (const c of chunks) {
      const out = await captionsForChunk(groqKey, c);
      out.forEach((x) => (captionsById[x.id] = x.caption));
    }
  }

  const output = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    updated_at: cfg.updated_at || null,
    categories: {},
  };

  for (const cat of CATEGORY_ORDER) {
    output.categories[cat] = cfg.categories[cat].map((it, idx) => {
      const id = buildItemId(cat, idx);
      return {
        id,
        url: it.url,
        title: it.title,
        image: it.image,
        price: it.price,
        store: it.store,
        why: it.why,
        caption: captionsById[id] || '',
      };
    });
  }

  fs.mkdirSync('deals', { recursive: true });
  fs.writeFileSync('deals/today.json', JSON.stringify(output, null, 2));
  console.log('deals/today.json written successfully');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

