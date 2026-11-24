// Fresh Home: fills Orpheon's Home with shelves.
//   New from your artists  - iTunes lookup of the artists you play (and follow), newest first
//   Newest songs           - the songs of those releases, to play them all
//   Because you played X   - Deezer artist radio of the last artist you played
//   Popular in <country>   - Apple Music most-played songs and albums of your country
//   Moods and genres       - Deezer editors' playlists for the moods you pick
// Hooks for blocks have 3 s, so all network work happens in the `online` event (30 s) and Home
// only reads what is kept in storage. Docs: https://github.com/kota-zo/orpheon/blob/main/docs/extensions/API.md

var HOUR = 3600 * 1000, DAY = 24 * HOUR;
var TTL = { releases: 6 * HOUR, radio: 6 * HOUR, charts: 6 * HOUR, moods: DAY };
var RADIO_RESEED = 20 * 60 * 1000;   // a new "Because you played" at most every 20 minutes
var MAX_ARTISTS = 300;               // play counts kept
var LOOKUP_ARTISTS = 30;             // artists asked for new releases per refresh
var RESOLVE_PER_RUN = 10;            // new artist names looked up per refresh
var BUDGET = 25000;                  // ms of the online event's 30 s we allow ourselves

var COUNTRIES = {
  'Argentina': 'ar', 'Australia': 'au', 'Austria': 'at', 'Belgium': 'be', 'Brazil': 'br', 'Canada': 'ca',
  'Chile': 'cl', 'Colombia': 'co', 'Denmark': 'dk', 'Egypt': 'eg', 'Finland': 'fi', 'France': 'fr',
  'Germany': 'de', 'Greece': 'gr', 'Hong Kong': 'hk', 'India': 'in', 'Indonesia': 'id', 'Ireland': 'ie',
  'Israel': 'il', 'Italy': 'it', 'Japan': 'jp', 'Kenya': 'ke', 'Malaysia': 'my', 'Mexico': 'mx',
  'Netherlands': 'nl', 'New Zealand': 'nz', 'Nigeria': 'ng', 'Norway': 'no', 'Pakistan': 'pk', 'Peru': 'pe',
  'Philippines': 'ph', 'Poland': 'pl', 'Portugal': 'pt', 'Saudi Arabia': 'sa', 'Singapore': 'sg',
  'South Africa': 'za', 'South Korea': 'kr', 'Spain': 'es', 'Sweden': 'se', 'Switzerland': 'ch',
  'Taiwan': 'tw', 'Thailand': 'th', 'Turkey': 'tr', 'Ukraine': 'ua', 'United Arab Emirates': 'ae',
  'United Kingdom': 'gb', 'United States': 'us', 'Vietnam': 'vn'
};

// ---------- small helpers ----------

function get(key, fallback) { var v = myspoti.storage.get(key); return v === undefined || v === null ? fallback : v; }
function set(key, value) { myspoti.storage.set(key, value); }
function setting(key, fallback) { var v = myspoti.settings.get(key); return v === undefined || v === null ? fallback : v; }
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function hasFeature(name) { return !!(myspoti.features && myspoti.features.indexOf(name) >= 0); }
function list(text, max) {
  return String(text || '').split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; }).slice(0, max);
}

function countryCode() {
  var picked = setting('country', 'Auto');
  if (COUNTRIES[picked]) return COUNTRIES[picked];
  var parts = String(myspoti.locale || 'en').split('-');
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i].toLowerCase();
    if (p.length === 2) {
      for (var name in COUNTRIES) if (COUNTRIES[name] === p) return p;
    }
  }
  return 'us';
}

function countryName(code) {
  for (var name in COUNTRIES) if (COUNTRIES[name] === code) return name;
  return code.toUpperCase();
}

function windowMs() {
  var days = parseInt(String(setting('window', '30 days')), 10);
  return (isNaN(days) ? 30 : days) * DAY;
}

function art(url, size) {
  if (!url || String(url).indexOf('https://') !== 0) return undefined;
  return String(url).replace(/\/\d+x\d+bb\./, '/' + size + 'x' + size + 'bb.');
}

function ago(ms, now) {
  var days = Math.floor((now - ms) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  var d = new Date(ms);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()];
}

// Sends requests 4 at a time when the app can, one by one otherwise. Each answer is a parsed
// JSON object or null (failed request, refused host, bad JSON, an error body): one failure never
// stops the rest. No request may wait past `deadline`: the online event is stopped at 30 s and
// what it did not save is lost.
function fetchAll(urls, deadline) {
  var out = [];
  function left() { return Math.min(10000, deadline - Date.now() - 500); }
  function parse(r) {
    if (!r || r.error || !r.ok) {
      myspoti.log('request failed: ' + (r ? (r.error || r.status) : 'no answer'));
      return null;
    }
    var j;
    try { j = r.json(); } catch (e) { return null; }
    // Deezer answers its quota and "no data" errors with 200 and { error: {...} }
    if (j && j.error && typeof j.error === 'object') {
      myspoti.log('request failed: ' + (j.error.message || j.error.type || 'error') + (j.error.code ? ' (' + j.error.code + ')' : ''));
      return null;
    }
    return j;
  }
  function one(u) {
    if (left() < 1500) return null;
    try { return parse(myspoti.http.get(u, { timeout: left() })); } catch (e) { myspoti.log('request failed: ' + e); return null; }
  }
  if (hasFeature('http.all')) {
    for (var i = 0; i < urls.length; i += 4) {
      if (left() < 1500) { while (out.length < urls.length) out.push(null); break; }
      var t = left();
      var answers = myspoti.http.all(urls.slice(i, i + 4).map(function (u) { return { url: u, timeout: t }; }));
      answers.forEach(function (r, j) {
        // a request that never got an answer (timeout, reset) is asked once more, on its own, if time allows
        out.push(r && r.error && left() > 3000 ? one(urls[i + j]) : parse(r));
      });
    }
  } else {
    urls.forEach(function (u) { out.push(one(u)); });
  }
  return out;
}

// ---------- what you play ----------

function artistScore(a, now) { return a.n * Math.pow(0.5, (now - a.t) / (30 * DAY)); }

function countPlay(track) {
  var names = (track.artists && track.artists.length ? track.artists : [track.artist])
    .filter(function (n) { return !!n; }).slice(0, 3);
  if (names.length === 0) return;
  var now = Date.now();
  var artists = get('artists', {});
  names.forEach(function (name, i) {
    var k = norm(name);
    var a = artists[k] || { name: name, n: 0, t: now };
    a.n += i === 0 ? 1 : 0.5;
    a.t = now;
    a.name = name;
    artists[k] = a;
  });
  var keys = Object.keys(artists);
  if (keys.length > MAX_ARTISTS) {
    keys.sort(function (x, y) { return artistScore(artists[y], now) - artistScore(artists[x], now); });
    keys.slice(MAX_ARTISTS).forEach(function (k) { delete artists[k]; });
  }
  set('artists', artists);
  set('last', names[0]);
}

function topArtists(n) {
  var now = Date.now();
  var artists = get('artists', {});
  var follow = list(setting('follow', ''), 50);
  var seen = {}, out = [];
  follow.forEach(function (name) { var k = norm(name); if (!seen[k]) { seen[k] = 1; out.push(name); } });
  Object.keys(artists)
    .sort(function (x, y) { return artistScore(artists[y], now) - artistScore(artists[x], now); })
    .forEach(function (k) { if (!seen[k]) { seen[k] = 1; out.push(artists[k].name); } });
  return out.slice(0, n);
}

function radioSeed() {
  var last = get('last', null);
  if (!last) {
    var top = topArtists(1);
    return top.length ? top[0] : null;
  }
  return last;
}

// ---------- the shelves ----------

// iTunes artist ids by name, kept so each name is looked up once (a miss is retried after a week).
function itunesIds(names, cc, deadline) {
  var ids = get('itunesIds', {});
  var now = Date.now();
  var failed = false;
  var todo = names.filter(function (n) {
    var e = ids[norm(n)];
    return !e || (!e.id && now - e.at > 7 * DAY);
  }).slice(0, RESOLVE_PER_RUN);
  if (todo.length && Date.now() < deadline) {
    var answers = fetchAll(todo.map(function (n) {
      return 'https://itunes.apple.com/search?' + myspoti.query({ term: n, entity: 'musicArtist', limit: 5, country: cc });
    }), deadline);
    todo.forEach(function (n, i) {
      var r = answers[i];
      if (r === null) { failed = true; return; }   // try again next time, do not record a miss
      var results = (r.results || []);
      var exact = results.filter(function (x) { return norm(x.artistName) === norm(n); })[0];
      var pick = exact || null;
      ids[norm(n)] = { id: pick ? pick.artistId : 0, at: now };
    });
    set('itunesIds', ids);
  }
  var found = names.map(function (n) { var e = ids[norm(n)]; return e && e.id ? e.id : 0; })
    .filter(function (id) { return id > 0; });
  return found.length === 0 && failed ? null : found;   // null: unreachable, not "no artist found"
}

// What the releases shelf depends on: when it changes, the shelf is asked again.
function releasesKey(cc) { return [cc, list(setting('follow', ''), 50).join(','), windowMs()].join('|'); }

function refreshReleases(cc, deadline) {
  var key = releasesKey(cc);
  var names = topArtists(LOOKUP_ARTISTS);
  if (names.length === 0) return { at: Date.now(), cc: cc, key: key, albums: [], songs: [] };
  var ids = itunesIds(names, cc, deadline);
  if (ids === null) return null;
  var now = Date.now(), since = now - windowMs();
  var albums = [], songs = [], seenAlbum = {}, seenSong = {};
  var urls = [];
  for (var i = 0; i < ids.length; i += 10) {
    var batch = ids.slice(i, i + 10).join(',');
    urls.push('https://itunes.apple.com/lookup?' + myspoti.query({ id: batch, entity: 'album', sort: 'recent', limit: 10, country: cc }));
    urls.push('https://itunes.apple.com/lookup?' + myspoti.query({ id: batch, entity: 'song', sort: 'recent', limit: 10, country: cc }));
  }
  if (Date.now() >= deadline) return null;
  fetchAll(urls, deadline).forEach(function (r) {
    if (!r) return;
    (r.results || []).forEach(function (x) {
      var when = Date.parse(x.releaseDate || '');
      if (isNaN(when) || when < since || when > now + DAY) return;
      if (x.wrapperType === 'collection' && x.collectionId) {
        var ak = norm(x.artistName) + '|' + norm(String(x.collectionName).replace(/ - (Single|EP)$/i, ''));
        if (seenAlbum[x.collectionId] || seenAlbum[ak]) return;
        seenAlbum[x.collectionId] = seenAlbum[ak] = 1;
        albums.push({ uri: 'itunes:album:' + x.collectionId, title: x.collectionName, artist: x.artistName,
          image: art(x.artworkUrl100, 300), when: when });
      } else if (x.wrapperType === 'track' && x.kind === 'song' && x.trackId) {
        var sk = norm(x.artistName) + '|' + norm(x.trackName);
        if (seenSong[x.trackId] || seenSong[sk]) return;
        seenSong[x.trackId] = seenSong[sk] = 1;
        songs.push({ uri: 'itunes:track:' + x.trackId, title: x.trackName, artist: x.artistName,
          image: art(x.artworkUrl100, 300), when: when });
      }
    });
  });
  var byDate = function (a, b) { return b.when - a.when; };
  albums.sort(byDate); songs.sort(byDate);
  return { at: Date.now(), cc: cc, key: key, albums: albums.slice(0, 24), songs: songs.slice(0, 40) };
}

function deezerArtistId(name, deadline) {
  var ids = get('deezerIds', {});
  var e = ids[norm(name)];
  if (e && (e.id || Date.now() - e.at < 7 * DAY)) return e.id;
  var r = fetchAll(['https://api.deezer.com/search/artist?' + myspoti.query({ q: name, limit: 5 })], deadline)[0];
  if (r === null) return null;      // unreachable: not a miss
  var exact = (r.data || []).filter(function (x) { return norm(x.name) === norm(name); })[0];
  ids[norm(name)] = { id: exact ? exact.id : 0, at: Date.now() };
  set('deezerIds', ids);
  return exact ? exact.id : 0;
}

function refreshRadio(seed, deadline) {
  if (!seed) return { at: Date.now(), seed: null, tracks: [] };
  var id = deezerArtistId(seed, deadline);
  if (id === null) return null;
  if (!id) return { at: Date.now(), seed: seed, tracks: [] };
  var r = fetchAll(['https://api.deezer.com/artist/' + id + '/radio?limit=40'], deadline)[0];
  if (r === null) return null;
  var seen = {}, tracks = [];
  (r.data || []).forEach(function (t) {
    if (!t.id || seen[t.id]) return;   // `readable` is about Deezer's own streaming: not ours
    seen[t.id] = 1;
    tracks.push({ uri: 'deezer:track:' + t.id, title: t.title, artist: t.artist ? t.artist.name : '',
      image: t.album && t.album.cover_medium ? t.album.cover_medium : undefined });
  });
  return { at: Date.now(), seed: seed, tracks: tracks.slice(0, 30) };
}

function refreshCharts(cc, deadline) {
  var base = 'https://rss.marketingtools.apple.com/api/v2/' + cc + '/music/most-played/';
  var answers = fetchAll([base + '25/songs.json', base + '25/albums.json'], deadline);
  if (answers[0] === null && answers[1] === null) return null;
  function items(r, kind) {
    return ((r && r.feed && r.feed.results) || []).filter(function (x) { return x.id; }).map(function (x) {
      return { uri: 'itunes:' + kind + ':' + x.id, title: x.name, artist: x.artistName, image: art(x.artworkUrl100, 300) };
    });
  }
  return { at: Date.now(), cc: cc, songs: items(answers[0], 'track'), albums: items(answers[1], 'album') };
}

function refreshMoods(deadline) {
  var moods = list(setting('moods', 'Chill, Workout, Focus, Party'), 6);
  if (moods.length === 0) return { at: Date.now(), key: '', shelves: [] };
  var answers = fetchAll(moods.map(function (m) {
    return 'https://api.deezer.com/search/playlist?' + myspoti.query({ q: m, limit: 25 });
  }), deadline);
  if (answers.every(function (r) { return r === null; })) return null;
  var shelves = moods.map(function (mood, i) {
    var found = ((answers[i] && answers[i].data) || []).filter(function (p) { return p.id && (p.nb_tracks || 0) >= 15; });
    var editors = found.filter(function (p) { return p.user && /deezer/i.test(p.user.name || ''); });
    var rest = found.filter(function (p) { return editors.indexOf(p) < 0; });
    var picks = editors.concat(rest).slice(0, 6).map(function (p) {
      return { uri: 'deezer:playlist:' + p.id, title: p.title, subtitle: (p.nb_tracks || 0) + ' songs',
        image: p.picture_medium || undefined };
    });
    return { title: mood, playlists: picks };
  }).filter(function (s) { return s.playlists.length > 0; });
  return { at: Date.now(), key: moods.join(','), shelves: shelves };
}

// The whole refresh, in the `online` event. Each shelf is refreshed only when it is old, when
// what it depends on changed, or when the user asked (`force`). A failed shelf keeps its last answer.
function refresh() {
  var start = Date.now(), deadline = start + BUDGET;
  var force = get('force', false);
  var cc = countryCode();
  var cache = get('cache', {});
  var errors = [];
  function due(old, ttl, changed) { return force || changed || !old || start - old.at > ttl; }
  function step(name, fn) {
    if (Date.now() >= deadline - 1500) { errors.push(name + ': out of time'); return; }
    try {
      var value = fn();
      if (value) { cache[name] = value; set('cache', cache); }   // kept at once: the event may be stopped
      else errors.push(name + ': no answer');
    } catch (e) { errors.push(name + ': ' + e); }
  }

  // Cheapest and most wanted first: what is left when time runs out is the moods shelf.
  if (setting('showCharts', true) && due(cache.charts, TTL.charts, cache.charts && cache.charts.cc !== cc)) {
    step('charts', function () { return refreshCharts(cc, deadline); });
  }
  var seed = radioSeed();
  var radio = cache.radio;
  if (setting('showRadio', true) && (due(radio, TTL.radio, false) ||
      (radio && seed && norm(radio.seed) !== norm(seed) && start - radio.at > RADIO_RESEED))) {
    step('radio', function () { return refreshRadio(seed, deadline); });
  }
  if (setting('showNew', true) && due(cache.releases, TTL.releases, cache.releases && cache.releases.key !== releasesKey(cc))) {
    step('releases', function () { return refreshReleases(cc, deadline); });
  }
  var moodKey = list(setting('moods', 'Chill, Workout, Focus, Party'), 6).join(',');
  if (setting('showMoods', true) && due(cache.moods, TTL.moods, cache.moods && cache.moods.key !== moodKey)) {
    step('moods', function () { return refreshMoods(deadline); });
  }

  pruneIds();
  if (errors.length === 0) set('force', false);   // a refresh the user asked for ends only once all of it came
  set('lastRun', { at: start, ms: Date.now() - start, errors: errors });
  if (errors.length) myspoti.log('refresh: ' + errors.join('; '));
  myspoti.ui.refresh('home');
}

// The id caches keep only the artists still counted or followed (and the radio's), so storage
// stays small and "Forget my artists" leaves no names behind.
function pruneIds() {
  var keep = {};
  Object.keys(get('artists', {})).forEach(function (k) { keep[k] = 1; });
  list(setting('follow', ''), 50).forEach(function (n) { keep[norm(n)] = 1; });
  var radio = get('cache', {}).radio;
  if (radio && radio.seed) keep[norm(radio.seed)] = 1;
  ['itunesIds', 'deezerIds'].forEach(function (name) {
    var ids = get(name, {}), changed = false;
    Object.keys(ids).forEach(function (k) { if (!keep[k]) { delete ids[k]; changed = true; } });
    if (changed) set(name, ids);
  });
}

function needsRefresh() {
  var cache = get('cache', {});
  var now = Date.now();
  function old(x, ttl) { return !x || now - x.at > ttl; }
  if (setting('showCharts', true) && old(cache.charts, TTL.charts)) return true;
  if (setting('showMoods', true) && old(cache.moods, TTL.moods)) return true;
  if (setting('showNew', true) && old(cache.releases, TTL.releases)) return true;
  if (setting('showRadio', true)) {
    var seed = radioSeed();
    if (old(cache.radio, TTL.radio)) return true;
    if (seed && norm(cache.radio.seed) !== norm(seed) && now - cache.radio.at > RADIO_RESEED) return true;
  }
  return false;
}

function askRefresh(force) {
  if (force) set('force', true);
  myspoti.work.whenOnline();
}

// ---------- Home ----------

// The app fails the whole Home answer for one image on a host the manifest does not list,
// so an image from anywhere else is left out (the item shows without it).
var IMAGE_HOSTS = /(^|\.)(mzstatic\.com|dzcdn\.net)$|^api\.deezer\.com$/;
function image(url) {
  var m = /^https:\/\/([^\/:?#]+)/.exec(String(url || ''));
  return m && IMAGE_HOSTS.test(m[1].toLowerCase()) ? url : undefined;
}

function items(xs, now, withWhen) {
  return xs.map(function (x) {
    return { uri: x.uri, title: cut(x.title, 100),
      subtitle: cut(withWhen && x.when ? x.artist + ' · ' + ago(x.when, now) : (x.subtitle || x.artist), 100),
      image: image(x.image) };
  });
}

// One quiet line at a time, never a pop-up: after 7 days a request for a 👍 on the Ratings issue,
// and only once that is hidden, after 30 days one line about the Ko-fi page. Both stay until hidden.
function askBlocks(now) {
  var since = get('since', now);
  var age = (now - since) / DAY;
  if (age >= 7 && !get('hideRate', false)) {
    return [{ type: 'text', style: 'caption', text: 'Like Fresh Home? A 👍 on the Ratings issue at github.com/VanshBhardwaj24/orpheon-fresh-home helps other people find it.' },
      { type: 'button', label: 'Hide this', icon: 'close', action: 'hideRate' }];
  }
  if (age >= 30 && get('hideRate', false) && !get('hideDonate', false)) {
    return [{ type: 'text', style: 'caption', text: 'Enjoying Fresh Home for a month? A coffee keeps updates coming: ko-fi.com/vanshmusic' },
      { type: 'button', label: 'Hide this', icon: 'close', action: 'hideDonate' }];
  }
  return [];
}

function home() {
  var cache = get('cache', {});
  var now = Date.now();
  var sections = [];

  var fresh = [];
  var r = cache.releases;
  if (setting('showNew', true) && r) {
    if (r.albums && r.albums.length) fresh.push({ type: 'albums', title: 'New from your artists', items: items(r.albums, now, true) });
    if (r.songs && r.songs.length) fresh.push({ type: 'tracks', title: 'Newest songs', items: items(r.songs.slice(0, 30), now, true) });
  }
  var radio = cache.radio;
  if (setting('showRadio', true) && radio && radio.tracks && radio.tracks.length) {
    fresh.push({ type: 'tracks', title: cut('Because you played ' + radio.seed, 60), items: items(radio.tracks, now, false) });
  }
  if (setting('showNew', true) || setting('showRadio', true)) {
    if (fresh.length === 0) {
      var played = Object.keys(get('artists', {})).length > 0 || list(setting('follow', ''), 1).length > 0;
      fresh.push({ type: 'text', style: 'caption', text: played
        ? 'Looking for new releases from your artists. They show here once found (nothing new in the window you picked shows nothing).'
        : 'Play a few songs, or add artists to follow in Fresh Home\'s settings: their new releases show here.' });
    }
    fresh.push({ type: 'button', label: 'Refresh', icon: 'refresh', action: 'refresh' });
    sections.push({ type: 'section', title: 'Fresh for you', blocks: fresh.slice(0, 12) });
  }

  var world = [];
  var c = cache.charts;
  if (setting('showCharts', true) && c) {
    if (c.songs && c.songs.length) world.push({ type: 'tracks', title: 'Top songs', items: items(c.songs, now, false) });
    if (c.albums && c.albums.length) world.push({ type: 'albums', title: 'Top albums', items: items(c.albums, now, false) });
  }
  var charted = world.length > 0;
  var m = cache.moods;
  if (setting('showMoods', true) && m && m.shelves) {
    m.shelves.forEach(function (s) {
      world.push({ type: 'playlists', title: cut(s.title, 40), items: items(s.playlists, now, false) });
    });
  }
  if (world.length) {
    var title = charted ? 'Popular in ' + countryName(c.cc) : 'Moods and genres';
    sections.push({ type: 'section', title: title, blocks: world.slice(0, 12) });
  } else if (setting('showCharts', true) || setting('showMoods', true)) {
    sections.push({ type: 'section', title: 'Popular near you', blocks: [
      { type: 'text', style: 'caption', text: 'Loading charts and playlists. They show here once the phone is online.' }
    ] });
  }
  var ask = askBlocks(now);
  if (ask.length) {
    if (sections.length) sections[0].blocks = sections[0].blocks.concat(ask).slice(0, 12);
    else sections.push({ type: 'section', title: 'Fresh Home', blocks: ask });
  }
  return sections.slice(0, 2);
}

// ---------- wiring ----------

myspoti.provide('home', function () { return home(); });

myspoti.provide('tap', function (e) {
  if (e.action === 'refresh') askRefresh(true);
  if (e.action === 'hideRate') { set('hideRate', true); myspoti.ui.refresh('home'); }
  if (e.action === 'hideDonate') { set('hideDonate', true); myspoti.ui.refresh('home'); }
});

myspoti.on('track', function (track) {
  countPlay(track);
  if (needsRefresh()) myspoti.work.whenOnline();
});

myspoti.on('online', function () { refresh(); });

myspoti.on('setting', function (e) {
  if (e.key === 'refresh' && e.pressed) return askRefresh(true);
  if (e.key === 'support') return;
  if (e.key === 'forget' && e.pressed) {
    set('artists', {}); set('last', null); set('itunesIds', {}); set('deezerIds', {});
    var cache = get('cache', {}); delete cache.releases; delete cache.radio; set('cache', cache);
    myspoti.ui.refresh('home');
    return;
  }
  // refresh() sees these itself (they are in the shelves' keys) and asks again only the shelves they change
  if (e.key === 'country' || e.key === 'follow' || e.key === 'window' || e.key === 'moods') return askRefresh(false);
  myspoti.ui.refresh('home');          // a shelf switched on or off
  if (needsRefresh()) myspoti.work.whenOnline();
});

// Status for the extension's page: live once a refresh reached the catalogues.
myspoti.provide('status', function () {
  var run = get('lastRun', null);
  if (!run) return { live: true, detail: 'Waiting for the first refresh' };
  if (run.errors && run.errors.length && Object.keys(get('cache', {})).length === 0) {
    return { live: false, detail: 'Could not reach Apple or Deezer yet. It tries again when the phone is online.' };
  }
  return { live: true, detail: 'Refreshed ' + ago(run.at, Date.now()).toLowerCase() +
    (run.errors && run.errors.length ? ' · ' + cut(run.errors.join('; '), 120) : '') };
});

if (get('since', 0) === 0) set('since', Date.now());
if (needsRefresh()) myspoti.work.whenOnline();
