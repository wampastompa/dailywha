const https = require('https');
const fs = require('fs');

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
        catch(e) { resolve({}); }
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
      streaming: streaming.length > 0 ? streaming : (pick.streaming || [])
    };
  } catch(e) {
    console.log('Enrichment error for', pick.title, ':', e.message);
    return pick;
  }
}

async function main() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long', timeZone: 'America/Chicago' });
  const day = now.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Chicago' });
  const weekday = now.toLocaleString('en-US', { weekday: 'long', timeZone: 'America/Chicago' });
  const year = now.getFullYear();
  const dateStr = weekday + ', ' + month + ' ' + day + ', ' + year;
  const monthDay = month + ' ' + day;

  console.log('Generating picks for:', dateStr);

  const prompt = `Today is ${dateStr}.

You are the editor of MovieWha, a daily film recommendation site. Generate exactly 4 film picks for today. Return ONLY valid JSON, no markdown, no explanation, no backticks.

Rules:
- hero: The film of the day. Must be tied to TODAY specifically — a national/international observance, a major actor or director birthday, a release anniversary, or a cultural moment. The hook must be REAL and verifiable.
- birthday: A different film starring an actor or director who was born on ${monthDay} (any year). Pick their best or most beloved film.
- gem: An underrated or lesser-known film in a randomly chosen genre. Avoid obvious blockbusters.
- awful: A real film with a very low IMDb score (under 4.0). Should be entertainingly bad.

Return this exact JSON structure:
{
  "hero": {
    "title": "Film Title",
    "year": 1999,
    "hook": "Short reason tied to today",
    "blurb": "2-3 sentence opinionated pitch.",
    "genre": "Drama / Thriller",
    "runtime_min": 112,
    "streaming": ["Netflix"],
    "cast": ["Actor One", "Actor Two", "Actor Three"]
  },
  "birthday": {
    "title": "Film Title",
    "year": 1985,
    "hook": "Born today — Name, Age",
    "blurb": "2 sentence pitch.",
    "genre": "Comedy",
    "cast": ["Actor One", "Actor Two"]
  },
  "gem": {
    "title": "Film Title",
    "year": 2003,
    "hook": "Genre gem — western",
    "blurb": "2 sentence pitch.",
    "genre": "Western",
    "cast": ["Actor One", "Actor Two"]
  },
  "awful": {
    "title": "Film Title",
    "year": 2007,
    "hook": "Awful of the day",
    "blurb": "2 sentence roast.",
    "genre": "Action",
    "cast": ["Actor One", "Actor Two"]
  }
}`;

  const claudeRes = await httpsPost('api.anthropic.com', '/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  });

  const rawText = claudeRes.content[0].text.trim();
  console.log('Claude response received');

  const picks = JSON.parse(rawText);

  const [hero, birthday, gem, awful] = await Promise.all([
    enrichPick(picks.hero),
    enrichPick(picks.birthday),
    enrichPick(picks.gem),
    enrichPick(picks.awful)
  ]);

  const output = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    hero,
    birthday,
    gem,
    awful
  };

  fs.writeFileSync('moviewha/today.json', JSON.stringify(output, null, 2));
  console.log('today.json written successfully');
  console.log('Hero:', hero.title, '(' + hero.year + ')');
  console.log('Birthday:', birthday.title);
  console.log('Gem:', gem.title);
  console.log('Awful:', awful.title);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
