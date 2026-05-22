// MyTracker server — Express app serving the static client plus a small
// authenticated API. Each account's calorie/weight/preset data is stored as
// one JSON blob in SQLite, mirroring what the client used to keep in
// localStorage, so the frontend rewrite stayed minimal.
import express from 'express';
import cookieSession from 'cookie-session';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const rootDir = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Generous ceiling for a state blob — real payloads are a few KB.
const MAX_STATE_BYTES = 256 * 1024;

// Defaults handed to a brand-new account. These mirror the client's defaults.
const DEFAULT_DATA = {
    state: {
        goal: 2000,
        maintenance: 2500,
        history: {},
        weightHistory: {},
        theme: 'light',
        unit: 'imperial'
    },
    presets: [
        { id: 1, name: 'Hamburger', calories: 350 },
        { id: 2, name: 'Medium Fries', calories: 400 },
        { id: 3, name: 'Chips', calories: 200 },
        { id: 4, name: 'Boba Tea', calories: 500 }
    ]
};

// ===== Password hashing (scrypt, from node:crypto — no dependency) =====
// Stored form: "scrypt$<saltHex>$<hashHex>".
function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    // timingSafeEqual requires equal lengths — guard first.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ===== Prepared statements =====
const qUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const qUserById = db.prepare('SELECT id, email FROM users WHERE id = ?');
const qInsertUser = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
const qGetState = db.prepare('SELECT data FROM user_state WHERE user_id = ?');
const qUpsertState = db.prepare(`
    INSERT INTO user_state (user_id, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

// ===== Middleware =====
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

const sessionSecret = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
if (IS_PROD && sessionSecret === 'dev-insecure-secret-change-me') {
    console.warn('WARNING: SESSION_SECRET is not set — set it before running in production.');
}
app.use(cookieSession({
    name: 'mytracker.sid',
    secret: sessionSecret,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,                       // HTTPS-only cookie in production
    maxAge: 30 * 24 * 60 * 60 * 1000       // 30 days
}));

// A few baseline security headers (the CSP itself lives in index.html).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    res.status(401).json({ error: 'Not authenticated.' });
}

// ===== Auth routes =====
app.post('/api/auth/signup', (req, res) => {
    // Emails are stored and matched lowercased so case never splits an account.
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8 || password.length > 200) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (qUserByEmail.get(email)) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const info = qInsertUser.run(email, hashPassword(password));
    const userId = Number(info.lastInsertRowid);
    qUpsertState.run(userId, JSON.stringify(DEFAULT_DATA));
    req.session.userId = userId;
    res.json({ email });
});

app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = qUserByEmail.get(email);

    // Always run a hash comparison so a missing user and a wrong password
    // take a similar amount of time.
    const ok = user
        ? verifyPassword(password, user.password_hash)
        : verifyPassword(password, 'scrypt$00$00');
    if (!user || !ok) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    req.session.userId = user.id;
    res.json({ email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
    const userId = req.session?.userId;
    const user = userId ? qUserById.get(userId) : null;
    if (!user) {
        req.session = null;
        return res.status(401).json({ error: 'Not authenticated.' });
    }
    res.json({ email: user.email });
});

// ===== Data routes (authenticated) =====
app.get('/api/state', requireAuth, (req, res) => {
    const row = qGetState.get(req.session.userId);
    res.json(row ? JSON.parse(row.data) : DEFAULT_DATA);
});

app.put('/api/state', requireAuth, (req, res) => {
    const body = req.body;
    if (!body || typeof body.state !== 'object' || body.state === null || !Array.isArray(body.presets)) {
        return res.status(400).json({ error: 'Invalid payload.' });
    }
    const serialized = JSON.stringify({ state: body.state, presets: body.presets });
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
        return res.status(413).json({ error: 'Payload too large.' });
    }
    qUpsertState.run(req.session.userId, serialized);
    res.json({ ok: true });
});

// Unknown API paths should fail as JSON, not fall through to the static client.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ===== Static client =====
app.use(express.static(join(rootDir, 'public'), { extensions: ['html'] }));

// ===== Error handler (e.g. malformed JSON body) =====
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.status === 400) {
        return res.status(400).json({ error: 'Malformed request.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
});

const server = app.listen(PORT, () => {
    console.log(`MyTracker running on http://localhost:${PORT}`);
});

// A taken port otherwise surfaces as an unhandled 'error' event with a raw
// stack trace — turn it into a clear, actionable message.
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nPort ${PORT} is already in use by another process.`);
        console.error('Free that port, or start MyTracker on a different one:');
        console.error('  PORT=3100 npm run dev\n');
        process.exit(1);
    }
    throw err;
});
