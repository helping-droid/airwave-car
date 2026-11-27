(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var RELAY = /\.(web\.app|firebaseapp\.com|github\.io)$/.test(location.hostname) || /[?&]relay=1/.test(location.search);
  var DB = (location.search.match(/[?&]db=([^&]+)/) || [])[1] ? decodeURIComponent(location.search.match(/[?&]db=([^&]+)/)[1]) : 'https://airwave-7edeb-default-rtdb.firebaseio.com';
  var state = { tab: 'live', section: null, page: 0, query: '', items: [], current: null, hls: null, tv: false };

  function api(path, body) {
    if (RELAY) return relay(path, body);
    var opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' }
                   : { credentials: 'same-origin' };
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('PIN needed'); }
        if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
        return j;
      });
    });
  }
  function enc(s) { return encodeURIComponent(s); }
  function toast(t) { var e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(function () { e.classList.remove('show'); }, 2600); }

  // ---------- browser streamer relay (requests go to the phone through Firebase)
  var car = { code: null, pending: {}, phone: null, started: false, esRes: null, esPhone: null, generation: 0, lastSeen: 0, waitingSince: 0, lastBeat: 0, timer: null };
  function fb(method, path, obj) {
    return fetch(DB + path + '.json', { method: method, headers: { 'Content-Type': 'application/json' }, body: obj === undefined ? undefined : JSON.stringify(obj) });
  }
  function newCode() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c = '', r = new Uint32Array(6);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < 6; i++) c += A[r[i] % A.length];
    return c;
  }
  function relay(path, body) {
    var q = '', p = path, i = path.indexOf('?');
    if (i >= 0) { p = path.slice(0, i); q = path.slice(i + 1); }
    var room = car.code;
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { delete car.pending[id]; reject(new Error('Phone not answering — is Airwave open with Browser Streamer connected?')); }, 45000);
      car.pending[id] = function (res) {
        clearTimeout(t);
        var j = {}; try { j = JSON.parse(res.d || '{}'); } catch (e) {}
        if (res.s >= 200 && res.s < 300) resolve(j); else reject(new Error(j.error || ('Error ' + res.s)));
      };
      fb('PUT', '/screens/' + room + '/req/' + id, { p: p, q: q, m: body ? 'POST' : 'GET', b: body || '', t: { '.sv': 'timestamp' } })
        .catch(function () { clearTimeout(t); delete car.pending[id]; reject(new Error('No internet in the browser')); });
    });
  }
  function onRes(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    var deliver = function (id, r) { if (r && car.pending[id]) { var f = car.pending[id]; delete car.pending[id]; f(r); fb('DELETE', '/screens/' + car.code + '/res/' + id); } };
    if (m.path === '/') { if (m.data) for (var k in m.data) deliver(k, m.data[k]); }
    else { var id = m.path.slice(1).split('/')[0]; if (m.path.split('/').length === 2) deliver(id, m.data); }
  }
  var PHONE_FRESH_MS = 45000, PAIR_RESET_MS = 120000;
  function phoneOnline() {
    return !!(car.phone && car.phone.device && car.lastSeen && Date.now() - car.lastSeen < PHONE_FRESH_MS);
  }
  function showPhoneState() {
    var on = phoneOnline();
    $('pair').classList.toggle('hidden', on);
    if (on && !car.started) { car.started = true; start(); toast('Connected to ' + car.phone.device); }
    if (!on) $('pairMsg').textContent = car.started ? 'Phone disconnected. Reconnect with this code; a new code appears after two minutes.' : 'Enter this code in Airwave → Browser Streamer. It refreshes after two minutes without a phone.';
  }
  function onPhone(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    var wasConnected = car.started;
    if (m.path === '/') car.phone = m.data; else if (car.phone || m.data) { car.phone = car.phone || {}; car.phone[m.path.slice(1)] = m.data; }
    // A deleted record after pairing is an explicit disconnect, not a transient SSE error.
    if (m.path === '/' && m.data === null && wasConnected) { carStart(); return; }
    var seen = car.phone && Number(car.phone.seen);
    if (seen > 0 && seen <= Date.now() + 30000) car.lastSeen = Math.max(car.lastSeen, Math.min(seen, Date.now()));
    showPhoneState();
  }
  function browserBeat(room, generation) {
    car.lastBeat = Date.now();
    fb('PUT', '/screens/' + room + '/car', { t: { '.sv': 'timestamp' } }).catch(function () {
      if (generation === car.generation) $('pairMsg').textContent = 'No internet in this browser.';
    });
  }
  function checkPairing() {
    if (!RELAY || !car.code) return;
    if (Date.now() - (car.lastSeen || car.waitingSince) >= PAIR_RESET_MS) { carStart(); return; }
    showPhoneState();
  }
  function carStart() {
    var old = car.code, generation = ++car.generation;
    if (car.esRes) car.esRes.close(); if (car.esPhone) car.esPhone.close();
    if (car.timer) clearInterval(car.timer);
    for (var id in car.pending) car.pending[id]({ s: 409, d: '{"error":"Pairing reset — enter the new code shown in this browser."}' });
    car.pending = {}; car.phone = null; car.started = false; car.lastSeen = 0; car.waitingSince = Date.now();
    resetPlayer(); state.current = null; state.items = []; $('player').classList.add('hidden');
    $('remote').classList.add('hidden'); $('pad').classList.add('hidden'); $('tabs').innerHTML = ''; $('sections').innerHTML = ''; clearGrid('Connect your phone to browse.');
    // Codes are session-only: never resurrect an old room from localStorage after reload.
    try { localStorage.removeItem('aw_code'); } catch (e) {}
    do { car.code = newCode(); } while (car.code === old);
    var room = car.code;
    $('pairCode').textContent = room; showPhoneState();
    if (old) fb('DELETE', '/screens/' + old).catch(function () {});
    browserBeat(room, generation);
    car.esRes = new EventSource(DB + '/screens/' + room + '/res.json');
    var response = function (ev) { if (generation === car.generation) onRes(ev); };
    car.esRes.addEventListener('put', response); car.esRes.addEventListener('patch', response);
    car.esPhone = new EventSource(DB + '/screens/' + room + '/phone.json');
    var presence = function (ev) { if (generation === car.generation) onPhone(ev); };
    car.esPhone.addEventListener('put', presence); car.esPhone.addEventListener('patch', presence);
    car.timer = setInterval(function () { checkPairing(); if (generation === car.generation && Date.now() - car.lastBeat >= 20000) browserBeat(room, generation); }, 5000);
  }
  $('newCode').onclick = function () { carStart(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkPairing(); });
  window.addEventListener('pageshow', function () { checkPairing(); });

  // ---------- login
  function showLogin() { $('login').classList.remove('hidden'); setTimeout(function () { $('pin').focus(); }, 50); }
  $('pinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/login', 'pin=' + enc($('pin').value)).then(function () {
      $('login').classList.add('hidden'); $('pinMsg').textContent = ''; start();
    }).catch(function (e) { $('pinMsg').textContent = e.message; $('pin').select(); });
  });

  // ---------- tabs / sections
  function start() {
    api('/api/info').then(function (i) {
      state.tv = !!i.tv;
      $('remoteBtn').classList.toggle('hidden', !state.tv);
    }).catch(function () {});
    api('/api/tabs').then(function (tabs) {
      var nav = $('tabs'); nav.innerHTML = '';
      tabs.forEach(function (t) {
        var b = document.createElement('button'); b.textContent = t.title; b.dataset.id = t.id;
        b.onclick = function () { selectTab(t.id); };
        nav.appendChild(b);
      });
      selectTab(localStorage.getItem('aw_tab') || 'live');
    }).catch(function () {});
  }
  function selectTab(id) {
    state.tab = id; try { localStorage.setItem('aw_tab', id); } catch (e) {}
    Array.prototype.forEach.call($('tabs').children, function (b) { b.classList.toggle('on', b.dataset.id === id); });
    $('q').value = ''; $('q').placeholder = 'Search ' + (($('tabs').querySelector('.on') || {}).textContent || 'this tab').replace(/^\S+\s/, '');
    $('sections').innerHTML = ''; clearGrid('Loading…');
    api('/api/sections?tab=' + enc(id)).then(function (secs) {
      var box = $('sections'); box.innerHTML = '';
      secs.forEach(function (s) {
        var b = document.createElement('button'); b.textContent = s.title; b.dataset.id = s.id;
        b.onclick = function () { selectSection(s.id, s.title); };
        box.appendChild(b);
      });
      if (secs.length) {
        var first = secs[0];
        var pref = id === 'live' ? ['recent'] : id === 'radio' ? ['near'] : ['foryou'];
        for (var pi = pref.length - 1; pi >= 0; pi--) for (var i = 0; i < secs.length; i++) if (secs[i].id === pref[pi]) first = secs[i];
        selectSection(first.id, first.title);
      } else clearGrid('Nothing here yet.');
    }).catch(function (e) { clearGrid(e.message); });
  }
  function selectSection(id, title) {
    state.section = id; state.sectionTitle = title; state.query = ''; state.page = 0;
    Array.prototype.forEach.call($('sections').children, function (b) { b.classList.toggle('on', b.dataset.id === id); });
    $('heading').textContent = title;
    clearGrid('Loading…');
    loadPage();
  }
  function loadPage() {
    var url = state.query ? '/api/search?tab=' + enc(state.tab) + '&q=' + enc(state.query) + '&section=' + enc(state.section)
                          : '/api/items?tab=' + enc(state.tab) + '&section=' + enc(state.section) + '&page=' + state.page;
    var token = (state.token = (state.token || 0) + 1);
    api(url).then(function (r) {
      if (token !== state.token) return;
      render(r.items, state.page > 0);
      $('more').classList.toggle('hidden', !r.more);
      $('status').textContent = r.total === 0 ? 'Nothing found.' : '';
    }).catch(function (e) { if (token === state.token) $('status').textContent = e.message; });
  }
  function clearGrid(msg) { $('grid').innerHTML = ''; $('status').textContent = msg || ''; $('more').classList.add('hidden'); }
  $('more').onclick = function () { state.page++; loadPage(); };
  $('searchForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('q').value.trim(); if (!q) return;
    state.query = q; state.page = 0;
    Array.prototype.forEach.call($('sections').children, function (b) { b.classList.remove('on'); });
    $('heading').textContent = 'Results for “' + q + '”';
    clearGrid('Searching…'); loadPage();
  });

  // ---------- tiles
  function initials(t) { return (t || '?').replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '▶'; }
  function render(list, append) {
    var g = $('grid'); if (!append) g.innerHTML = '';
    list.forEach(function (it) {
      var d = document.createElement('div'); d.className = 'tile'; d.tabIndex = 0;
      var logo = it.kind === 'hls' || it.kind === 'ytlive' || it.kind === 'audio' && state.tab === 'radio';
      if (logo && it.img) d.classList.add('logoart');
      var art = document.createElement('div'); art.className = 'art';
      if (it.img) art.style.backgroundImage = 'url("' + it.img.replace(/"/g, '%22') + '")'; else art.textContent = initials(it.title);
      var img = new Image(); img.onerror = function () { art.style.backgroundImage = ''; d.classList.remove('logoart'); art.textContent = initials(it.title); }; if (it.img) img.src = it.img;
      var t = document.createElement('div'); t.className = 't'; t.textContent = it.title;
      var s = document.createElement('div'); s.className = 's'; s.textContent = it.sub || '';
      var acts = document.createElement('div'); acts.className = 'acts';
      if (state.tv && it.tv && it.kind !== 'podshow') {
        var tv = document.createElement('button'); tv.textContent = '📺'; tv.title = 'Play on TV';
        tv.onclick = function (e) { e.stopPropagation(); playOnTv(it); }; acts.appendChild(tv);
      }
      if (it.fav !== undefined) {
        var f = document.createElement('button'); f.textContent = it.fav ? '★' : '☆'; f.title = 'Favourite';
        f.onclick = function (e) {
          e.stopPropagation();
          api('/api/fav', 'id=' + enc(it.id)).then(function (r) { it.fav = r.fav; f.textContent = r.fav ? '★' : '☆'; toast(r.fav ? 'Added to favourites' : 'Removed from favourites'); }).catch(function (er) { toast(er.message); });
        }; acts.appendChild(f);
      }
      d.appendChild(art); d.appendChild(t); d.appendChild(s); d.appendChild(acts);
      d.onclick = function () { open(it); };
      d.onkeydown = function (e) { if (e.key === 'Enter') open(it); };
      g.appendChild(d);
    });
  }
  function open(it) {
    if (it.kind === 'podshow' || it.kind === 'catalogshow' || it.kind === 'catalogseason') {
      state.query = ''; state.token = (state.token || 0) + 1; $('browseBack').classList.remove('hidden'); $('heading').textContent = it.title + (it.kind === 'catalogseason' ? ' · ' + it.sub : ''); clearGrid(it.kind === 'catalogshow' ? 'Loading seasons…' : 'Loading episodes…');
      var browseToken = state.token; api('/api/episodes?id=' + enc(it.id)).then(function (r) { if(browseToken !== state.token) return; render(r.items, false); $('status').textContent = r.total ? '' : 'No episodes found.'; }).catch(function (e) { $('status').textContent = e.message; });
      return;
    }
    playHere(it);
  }

  $('browseBack').onclick = function () { $('browseBack').classList.add('hidden'); state.query = ''; state.page = 0; $('heading').textContent = state.sectionTitle || ''; clearGrid('Loading…'); loadPage(); };
  // ---------- player
  function resetPlayer() {
    state.playToken = (state.playToken || 0) + 1; state.catalogSources = null; state.catalogIndex = 0;
    ['catalogNext','catalogRetry','catalogFull'].forEach(function(id){ $(id).classList.add('hidden'); });
    $('frame').removeAttribute('sandbox');
    var v = $('video');
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    v.pause(); v.removeAttribute('src'); v.load(); v.style.display = 'none';
    $('frame').src = 'about:blank'; $('frame').style.display = 'none';
    var a = $('audio'); a.pause(); a.removeAttribute('src'); $('audioBox').style.display = 'none';
    $('playMsg').style.display = 'none';
    $('blocked').style.display = 'none';
  }
  function fail(msg) { var m = $('playMsg'); m.textContent = msg; m.style.display = 'block'; }
  function playHere(it, preferredSource) {
    resetPlayer(); var token = state.playToken;
    api('/api/play?id=' + enc(it.id)).then(function (p) {
      if (token !== state.playToken) return;
      state.current = it;
      $('player').classList.remove('hidden');
      $('nowTitle').textContent = p.title;
      $('tvBtn').classList.toggle('hidden', !(state.tv && p.tv));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if(p.kind === 'catalog') {
        state.catalogSources = p.sources || []; state.catalogIndex = Math.min(preferredSource || 0, Math.max(0,state.catalogSources.length-1));
        ['catalogNext','catalogRetry','catalogFull'].forEach(function(id){ $(id).classList.remove('hidden'); });
        $('catalogNext').disabled = state.catalogSources.length < 2;
        showCatalogSource();
      } else if (p.kind === 'hls') {
        var v = $('video'); v.style.display = 'block';
        if (RELAY) {
          p.src = (p.direct || '').replace(/^http:/, 'https:');
          if (!p.direct) { fail("This channel can't play here."); return; }
        }
        var cant = function () { fail(RELAY ? "This channel's provider doesn't allow playing it in a browser. Try another channel." : "This channel can't play in the browser — try 📺 Play on TV."); };
        var isHls = /\.m3u8($|\?)/i.test(p.direct || '') || !/\.(mp4|webm|mkv|mp3|aac)($|\?)/i.test(p.direct || '');
        if (isHls && window.Hls && Hls.isSupported()) {
          var h = new Hls({ maxBufferLength: 30 }); state.hls = h;
          h.on(Hls.Events.ERROR, function (e, d) { if (d.fatal) { if (d.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError(); else cant(); } });
          h.loadSource(p.src); h.attachMedia(v);
          h.on(Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () {}); });
        } else { v.src = p.src; v.onerror = cant; v.play().catch(function () {}); }
      } else if (p.kind === 'audio') {
        $('audioBox').style.display = 'flex'; $('audioTitle').textContent = p.title;
        $('audioArt').src = p.img || ''; $('audioArt').style.visibility = p.img ? 'visible' : 'hidden';
        var a = $('audio'); a.src = RELAY ? (p.src || '').replace(/^http:/, 'https:') : p.src; a.onerror = function () { fail("This stream can't play in the browser — try 📺 Play on TV."); };
        a.play().catch(function () {});
      } else if (p.embed === false) {
        $('blocked').style.display = 'flex';
        $('blockedText').textContent = (p.live ? p.title + ' is live, but the channel' : 'The owner of this video') + " only allows it to play on YouTube itself.";
        $('ytLink').href = p.watch;
      } else {
        var src = p.kind === 'ytvideo' ? 'https://www.youtube.com/embed/' + enc(p.ref) + '?autoplay=1&rel=0&playsinline=1&origin=' + enc(location.origin)
                : p.kind === 'ytlist' ? 'https://www.youtube.com/embed/videoseries?list=' + enc(p.ref) + '&autoplay=1&rel=0'
                : p.kind === 'ytlive' ? 'https://www.youtube.com/embed/live_stream?channel=' + enc(p.ref) + '&autoplay=1'
                : p.kind === 'archive' ? 'https://archive.org/embed/' + enc(p.ref) + '?autoplay=1' : 'about:blank';
        var f = $('frame'); f.style.display = 'block'; f.src = src;
      }
    }).catch(function (e) { toast(e.message); });
  }
  function showCatalogSource() {
    var source = state.catalogSources && state.catalogSources[state.catalogIndex];
    if(!source || !/^https:\/\/(cinesrc\.st|atlantic\.bz)\/embed\/(movie|tv)\/[0-9]+(?:[/?]|$)/.test(source.url || '')) { fail('This source cannot be opened here.'); return; }
    var f = $('frame'); f.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');
    f.style.display = 'block'; f.src = source.url;
    $('nowTitle').textContent = state.current.title + ' · ' + source.name;
    $('playMsg').style.display = 'none';
  }
  $('catalogNext').onclick = function(){ if(state.catalogSources && state.catalogSources.length){ playHere(state.current, (state.catalogIndex + 1) % state.catalogSources.length); }};
  $('catalogRetry').onclick = function(){ if(state.current) playHere(state.current,state.catalogIndex); };
  $('catalogFull').onclick = function(){ var p = $('player'); if(p.requestFullscreen) p.requestFullscreen().catch(function(){toast('Fullscreen is unavailable in this browser.');}); };
  function playOnTv(it) {
    api('/api/tv', 'id=' + enc(it.id)).then(function (r) {
      toast('Playing on TV: ' + it.title);
      if (state.current === it) { resetPlayer(); $('player').classList.add('hidden'); }
      $('remote').classList.toggle('hidden', !r.audio);
      if (!r.audio) $('pad').classList.remove('hidden');
      $('remoteTitle').textContent = '📺 ' + it.title;
    }).catch(function (e) { toast(e.message); });
  }
  $('tvBtn').onclick = function () { if (state.current) playOnTv(state.current); };
  $('closeBtn').onclick = function () { resetPlayer(); $('player').classList.add('hidden'); state.current = null; };
  Array.prototype.forEach.call(document.querySelectorAll('#remote button'), function (b) {
    b.onclick = function () {
      api('/api/cmd', 'op=' + b.dataset.op).then(function () { if (b.dataset.op === 'stop') $('remote').classList.add('hidden'); }).catch(function (e) { toast(e.message); });
    };
  });

  // ---------- TV remote
  $('remoteBtn').onclick = function () { $('pad').classList.toggle('hidden'); };
  $('padClose').onclick = function () { $('pad').classList.add('hidden'); };
  Array.prototype.forEach.call(document.querySelectorAll('#pad button[data-k]'), function (b) {
    b.onclick = function () {
      if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) {}
      api('/api/key', 'k=' + b.dataset.k).catch(function (e) { toast(e.message); });
    };
  });

  // ---------- keep sticky bars under the header
  function fitHeader() { document.documentElement.style.setProperty('--hdr', document.querySelector('header').offsetHeight + 'px'); }
  window.addEventListener('resize', fitHeader); setTimeout(fitHeader, 50); setTimeout(fitHeader, 800);

  // ---------- back to top
  window.addEventListener('scroll', function () { $('toTop').classList.toggle('hidden', window.scrollY < 600); });
  $('toTop').onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); };
  document.addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== $('q') && document.activeElement !== $('pin')) { e.preventDefault(); $('q').focus(); } });

  if (RELAY) carStart();
  else api('/api/tabs').then(function () { start(); }).catch(function () {});
})();
