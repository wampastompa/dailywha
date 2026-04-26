const https = require('https');
const fs = require('fs');

function normalizeReason(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/^\s*(movie of the day|released today|happy birthday|dumpster dive)\s*[-—:]\s*/i, '')
    .trim();
}

function normalizePick(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    ...p,
    reason: normalizeReason(p.reason),
  };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({}); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) {
          resolve({ error: { message: 'Non-JSON response from ' + hostname + path }, _raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function tmdb(path) {
  const url = 'https://api.themoviedb.org/3' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + process.env.TMDB_API_KEY + '&language=en-US';
  return httpsGet(url);
}

async function omdb(title, year) {
  const t = encodeURIComponent(title);
  return httpsGet('https://www.omdbapi.com/?t=' + t + '&y=' + year + '&apikey=' + process.env.OMDB_API_KEY);
}

async function enrichPick(pick) {
  try {
    const searchTitle = encodeURIComponent(pick.title);
    const search = await tmdb('/search/movie?query=' + searchTitle + '&year=' + pick.year);
    const movie = search.results && search.results[0];
    if (!movie) return pick;

    const id = movie.id;
    const [details, videos, providers] = await Promise.all([
      tmdb('/movie/' + id),
      tmdb('/movie/' + id + '/videos'),
      tmdb('/movie/' + id + '/watch/providers')
    ]);

    const trailer = videos.results && videos.results.find(
      v => v.type === 'Trailer' && v.site === 'YouTube'
    );

    const usProviders = providers.results && providers.results.US;
    const streaming = [];
    const watchUrl = usProviders && usProviders.link ? usProviders.link : null;
    if (usProviders && usProviders.flatrate) {
      usProviders.flatrate.slice(0, 3).forEach(p => streaming.push(p.provider_name));
    }

    const ratings = await omdb(pick.title, pick.year);
    let rtScore = null;
    if (ratings.Ratings) {
      const rt = ratings.Ratings.find(r => r.Source === 'Rotten Tomatoes');
      if (rt) rtScore = rt.Value;
    }

    return {
      ...pick,
      tmdb_id: id,
      poster_path: movie.poster_path || null,
      trailer_key: trailer ? trailer.key : null,
      imdb_rating: ratings.imdbRating || null,
      imdb_id: ratings.imdbID || null,
      rt_score: rtScore,
      metacritic: ratings.Metascore || null,
      runtime_min: details.runtime || pick.runtime_min || null,
      watch_url: watchUrl,
      streaming: streaming.length > 0 ? streaming : (pick.streaming || [])
    };
  } catch(e) {
    console.log('Enrichment error for', pick.title, ':', e.message);
    return pick;
  }
}

async function main() {
  if (!process.env.GROQ_API_KEY || !process.env.TMDB_API_KEY || !process.env.OMDB_API_KEY) {
    console.error('Missing required env vars: GROQ_API_KEY, TMDB_API_KEY, OMDB_API_KEY');
    process.exit(1);
  }

  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long', timeZone: 'America/Chicago' });
  const day = now.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Chicago' });
  const weekday = now.toLocaleString('en-US', { weekday: 'long', timeZone: 'America/Chicago' });
  const year = now.getFullYear();
  const dateStr = weekday + ', ' + month + ' ' + day + ', ' + year;
  const monthDay = month + ' ' + day;
  const monthDayNumeric = String(now.toLocaleString('en-US', { month: '2-digit', timeZone: 'America/Chicago' })) + '-' + String(now.toLocaleString('en-US', { day: '2-digit', timeZone: 'America/Chicago' }));

  console.log('Generating picks for:', dateStr);

  const prompt = `Today is ${dateStr}.

You are the editor of MovieWha, a daily film recommendation site. Generate exactly 4 film picks for today. Return ONLY valid JSON, no markdown, no explanation, no backticks.

Hard requirements:
- All picks must be REAL, widely known enough to find on TMDB/OMDb (avoid ultra-obscure entries that won't resolve).
- Use accurate years.
- Keep it positive overall.

Pick categories:
1) hero (Movie of the Day): Must be tied to TODAY via a real, positive day-specific observance/event (non-medical when possible). Choose ONE observance and name it explicitly in the reason. The reason must spell out exactly why this movie fits the observance and should start with wording like: "In honor of <observance>, ...". The connection must be specific and plausible (e.g., "Hairstylist Appreciation Day" -> "Hairspray"). Avoid DNA/malaria/illness topics unless there are no reasonable alternatives.
2) released (Released Today): A notable film whose initial theatrical release date matches today's month/day (${monthDay} / ${monthDayNumeric}) in its release year. The reason must spell out exactly why it was chosen and must explicitly include "Released today" and the release year (e.g., "Released today in 2007, ...").
3) birthday (Happy Birthday): Pick a real actor or actress born on ${monthDay}. The film MUST star them (they must be in the cast). Put their name FIRST in the cast array. Do NOT pick a film they are not in. The reason must spell out exactly why it was chosen and should explicitly include "Happy birthday to <name>, ...".
4) awful (Dumpster Dive): Any real film with terrible reviews/ratings (aim for IMDb under 4.0). The reason should be funny but not hateful.

For each pick, provide:
- title (string)
- year (number)
- reason (string): clear 1–2 sentence explanation that will be shown ABOVE the poster. For hero/released/birthday it MUST spell out exactly why it was chosen for that category (observance / release anniversary / birthday). DO NOT include the category name (do not start with “Movie of the Day”, “Released Today”, “Happy Birthday”, or “Dumpster Dive”). Just write the reason.
- blurb (string): 2–3 sentence opinionated pitch/roast.
- genre (string)
- runtime_min (number or null; only required for hero/released if you know it)
- streaming (array of strings; optional; can be empty)
- cast (array of 2–5 strings)

Return this exact JSON structure:
{
  "hero": {
    "title": "Film Title",
    "year": 1999,
    "reason": "1–2 sentences tying this movie to today's observance/event.",
    "blurb": "2-3 sentence opinionated pitch.",
    "genre": "Drama / Thriller",
    "runtime_min": 112,
    "streaming": ["Netflix"],
    "cast": ["Actor One", "Actor Two", "Actor Three"]
  },
  "released": {
    "title": "Film Title",
    "year": 2007,
    "reason": "Released today in 2007 — 1–2 sentence why it still rules.",
    "blurb": "2-3 sentence pitch.",
    "genre": "Action / Adventure",
    "runtime_min": 118,
    "streaming": ["Hulu"],
    "cast": ["Actor One", "Actor Two", "Actor Three"]
  },
  "birthday": {
    "title": "Film Title",
    "year": 1985,
    "reason": "Happy birthday — Name (born ${monthDay}, YEAR). 1–2 sentence why this is their signature film.",
    "blurb": "2 sentence pitch.",
    "genre": "Comedy",
    "cast": ["Actor One", "Actor Two"]
  },
  "awful": {
    "title": "Film Title",
    "year": 2007,
    "reason": "Dumpster Dive — a famously bad movie with terrible reviews.",
    "blurb": "2 sentence roast.",
    "genre": "Action",
    "cast": ["Actor One", "Actor Two"]
  }
}`;

  const groqRes = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
    model: 'llama-3.3-70b-versatile',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
  });

  if (!groqRes || groqRes.error) {
    console.error('Groq API error:', groqRes && groqRes.error ? groqRes.error : groqRes);
    throw new Error('Groq request failed');
  }
  if (!groqRes.choices || !groqRes.choices[0] || !groqRes.choices[0].message || !groqRes.choices[0].message.content) {
    console.error('Unexpected Groq response:', JSON.stringify(groqRes, null, 2));
    throw new Error('Groq response missing content');
  }

  const rawText = groqRes.choices[0].message.content.trim();
  console.log('Groq response received');

  const cleaned = rawText.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  const picks = JSON.parse(cleaned);

  if (!picks || !picks.hero || !picks.released || !picks.birthday || !picks.awful) {
    console.error('Invalid picks JSON:', cleaned);
    throw new Error('Picks JSON missing required keys');
  }

  const [hero, released, birthday, awful] = await Promise.all([
    enrichPick(normalizePick(picks.hero)),
    enrichPick(normalizePick(picks.released)),
    enrichPick(normalizePick(picks.birthday)),
    enrichPick(normalizePick(picks.awful))
  ]);

  const output = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    hero,
    released,
    birthday,
    awful
  };

  fs.writeFileSync('moviewha/today.json', JSON.stringify(output, null, 2));
  console.log('today.json written successfully');
  console.log('Hero:', hero.title, '(' + hero.year + ')');
  console.log('Released:', released.title);
  console.log('Birthday:', birthday.title);
  console.log('Awful:', awful.title);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
