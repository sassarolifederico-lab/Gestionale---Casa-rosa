// Sincronizzazione con Firebase (login + database Firestore).
// Caricato da index.html solo quando firebase-config.js contiene la configurazione.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const BB = window.BB, $ = s => document.querySelector(s);
const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
// The local cache keeps the app usable offline; writes are sent when the network is back
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const col = name => collection(fs, 'bb', 'main', name);
const metaRef = doc(fs, 'bb', 'main');
const KINDS = ['bookings', 'costs', 'guests'];

// Key-order-independent JSON, so a document read back from Firestore compares equal to what we wrote
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v ?? null);
const meta = db => ({ settings: db.settings, listino: db.listino });

// What the server is known to hold; push() sends only the differences
let synced = null, unsubs = [];
const snapshotOf = db => ({
  ...Object.fromEntries(KINDS.map(k => [k, new Map(db[k].map(x => [x.id, stable(x)]))])),
  meta: stable(meta(db)),
});

function push() {
  if (!synced) return;
  const db = BB.db, ops = [];
  for (const k of KINDS) {
    const cur = new Map(db[k].map(x => [x.id, x]));
    for (const [id, x] of cur) {
      const j = stable(x);
      if (synced[k].get(id) !== j) { ops.push(b => b.set(doc(col(k), id), JSON.parse(JSON.stringify(x)))); synced[k].set(id, j); }
    }
    for (const id of [...synced[k].keys()]) if (!cur.has(id)) { ops.push(b => b.delete(doc(col(k), id))); synced[k].delete(id); }
  }
  const m = stable(meta(db));
  if (m !== synced.meta) { ops.push(b => b.set(metaRef, JSON.parse(JSON.stringify(meta(db))))); synced.meta = m; }
  for (let i = 0; i < ops.length; i += 450) {
    const b = writeBatch(fs);
    ops.slice(i, i + 450).forEach(f => f(b));
    b.commit().catch(err => { console.error(err); BB.toast('Errore di sincronizzazione: ' + (err.code || err.message)); });
  }
  indicator();
}

let pending = false, offline = false;
function indicator() {
  const el = $('#syncDot'); el.hidden = false;
  const wait = pending || offline || !navigator.onLine;
  el.className = 'sync ' + (wait ? 'wait' : 'ok');
  el.textContent = wait ? 'Non sincronizzato' : 'Sincronizzato';
  el.title = wait ? 'Le modifiche sono salvate sul dispositivo e verranno inviate appena c\'è connessione.' : 'Tutti i dispositivi vedono gli stessi dati.';
}
addEventListener('online', indicator);
addEventListener('offline', indicator);

function stop() { unsubs.forEach(u => u()); unsubs = []; synced = null; BB.cloud.on = false; }

function listen(user) {
  const snaps = {};
  let first = true;
  const apply = () => {
    if (!KINDS.every(k => snaps[k]) || !snaps.meta) return;
    const db = BB.db;
    if (first) {
      first = false;
      const cloudEmpty = !snaps.meta.exists() && KINDS.every(k => snaps[k].empty);
      if (cloudEmpty) {
        // First login ever: offer to upload what this device already has
        const has = db.bookings.length || db.costs.length;
        if (has && !confirm(`Su questo dispositivo ci sono ${db.bookings.length} prenotazioni e ${db.costs.length} spese. Premi OK per caricarle online e vederle anche sugli altri dispositivi, oppure Annulla per partire da zero (prima ne scarico comunque un backup).`)) {
          $('#expJson').click();
          db.bookings = []; db.costs = []; db.guests = [];
        }
        synced = { ...Object.fromEntries(KINDS.map(k => [k, new Map()])), meta: '' };
        BB.cloud.on = true; BB.cloud.push = push;
        push(); BB.cache(); BB.render();
        return;
      }
      BB.cloud.on = true; BB.cloud.push = push;
    }
    for (const k of KINDS) db[k] = snaps[k].docs.map(d => d.data());
    if (snaps.meta.exists()) { const m = snaps.meta.data(); BB.db = { ...db, settings: m.settings, listino: m.listino }; }
    synced = snapshotOf(BB.db);
    pending = Object.values(snaps).some(s => s.metadata.hasPendingWrites);
    offline = Object.values(snaps).some(s => s.metadata.fromCache);
    BB.cache(); BB.render(); indicator();
  };
  const onErr = err => {
    console.error(err);
    stop();
    if (err.code === 'permission-denied') { signOut(auth); loginError('Questo account non è autorizzato a usare il gestionale.'); }
    else BB.toast('Errore di sincronizzazione: ' + err.code);
  };
  const opts = { includeMetadataChanges: true };
  unsubs.push(onSnapshot(col('bookings'), opts, s => { snaps.bookings = s; apply(); }, onErr));
  unsubs.push(onSnapshot(col('costs'), opts, s => { snaps.costs = s; apply(); }, onErr));
  unsubs.push(onSnapshot(col('guests'), opts, s => { snaps.guests = s; apply(); }, onErr));
  unsubs.push(onSnapshot(metaRef, opts, s => { snaps.meta = s; apply(); }, onErr));
  $('#cloudCard').hidden = false;
  $('#cloudInfo').textContent = `Collegato come ${user.email}. Le modifiche fatte qui compaiono da sole sugli altri telefoni e computer collegati con un account autorizzato, e funzionano anche senza internet: vengono inviate appena torna la connessione.`;
}

function loginError(msg) { $('#loginErr').textContent = msg; $('#login').hidden = false; }

onAuthStateChanged(auth, user => {
  stop();
  if (user) { $('#login').hidden = true; listen(user); }
  else { const pw = $('#loginForm').password; pw.type = 'password'; $('#pwShow').classList.remove('on'); $('#pwShow').setAttribute('aria-label', 'Mostra la password'); $('#login').hidden = false; $('#cloudCard').hidden = true; $('#syncDot').hidden = true; }
});

const ERR = {
  'auth/invalid-credential': 'Email o password sbagliate.',
  'auth/wrong-password': 'Email o password sbagliate.',
  'auth/user-not-found': 'Email o password sbagliate.',
  'auth/invalid-email': 'L\'email non è scritta correttamente.',
  'auth/too-many-requests': 'Troppi tentativi. Riprova tra qualche minuto.',
  'auth/network-request-failed': 'Nessuna connessione a internet.',
};
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $('#loginErr').textContent = '';
  try { await signInWithEmailAndPassword(auth, f.email.value.trim(), f.password.value); f.password.value = ''; }
  catch (err) { loginError(ERR[err.code] || 'Accesso non riuscito (' + err.code + ').'); }
};
$('#forgot').onclick = async () => {
  const email = $('#loginForm').email.value.trim();
  if (!email) { loginError('Scrivi prima la tua email, poi premi di nuovo.'); return; }
  try { await sendPasswordResetEmail(auth, email); loginError('Ti ho mandato un\'email per scegliere una nuova password.'); }
  catch (err) { loginError(ERR[err.code] || 'Invio non riuscito (' + err.code + ').'); }
};
$('#logout').onclick = () => { if (confirm('Uscire da questo dispositivo? I dati restano online.')) signOut(auth); };
