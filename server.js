"use strict";

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const admin = require("firebase-admin");
const firebaseServiceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const app = express();
const PORT = process.env.PORT || 3000;
const FREE_QUESTION_LIMIT = 3;
const PACKAGE_QUESTION_COUNT = 15;
const STORAGE_BUCKET = process.env.SUPABASE_BUCKET || "question-images";

const uploadsDir = path.join(__dirname, "uploads");
const answersDir = path.join(__dirname, "answers");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(answersDir, { recursive: true });

if (!process.env.DATABASE_URL) {
  throw new Error("Render Environment içinde DATABASE_URL tanımlanmalı.");
}
if (!process.env.SUPABASE_URL) {
  throw new Error("Render Environment içinde SUPABASE_URL tanımlanmalı.");
}
if (!process.env.SUPABASE_SECRET_KEY) {
  throw new Error("Render Environment içinde SUPABASE_SECRET_KEY tanımlanmalı.");
}
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
  throw new Error(
    "Render Environment içinde ADMIN_USER ve ADMIN_PASSWORD tanımlanmalı."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
});

pool.on("error", error =>
  console.error("Veritabanı bağlantı hatası:", error.code || "CONNECTION_ERROR")
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

const allowedImageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
]);

function imageContentType(file) {
  if (file.mimetype && file.mimetype.startsWith("image/")) {
    return file.mimetype;
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
  }[extension] || "application/octet-stream";
}

const imageFileFilter = (req, file, callback) => {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (
    (file.mimetype && file.mimetype.startsWith("image/")) ||
    allowedImageExtensions.has(extension)
  ) {
    return callback(null, true);
  }
  callback(new Error("Yalnızca görsel dosyaları yüklenebilir."));
};

const questionUpload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});
const answerUpload = multer({
  dest: answersDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Eski kayıtların görselleri, Render yeniden başlatılana kadar açılabilsin.
app.use("/uploads", express.static(uploadsDir));
app.use("/answers", express.static(answersDir));

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requestAdminLogin(res) {
  res.set("WWW-Authenticate", 'Basic realm="SorBi Hoca Paneli", charset="UTF-8"');
  return res.status(401).send("Hoca paneli için giriş yapmalısınız.");
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, encoded] = authorization.split(" ");
  if (scheme !== "Basic" || !encoded) return requestAdminLogin(res);

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch (_) {
    return requestAdminLogin(res);
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return requestAdminLogin(res);
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (
    !secureEqual(username, process.env.ADMIN_USER) ||
    !secureEqual(password, process.env.ADMIN_PASSWORD)
  ) {
    return requestAdminLogin(res);
  }
  next();
}


// Öğretmen cihazları yalnızca mevcut yönetici kimlik doğrulaması ile kaydedilir.
function teacherToken(body) {
  const token = body && body.fcmToken;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) return null;
  return token;
}
app.post('/admin/api/fcm-token', requireAdmin, asyncRoute(async (req, res) => {
  const token = teacherToken(req.body);
  if (!token) return res.status(400).json({ error: 'Geçersiz bildirim kimliği.' });
  await pool.query(
    "INSERT INTO sorbi.teacher_devices(fcm_token, owner_name, role) VALUES ($1,$2,'admin') ON CONFLICT (fcm_token) DO UPDATE SET owner_name = EXCLUDED.owner_name, role = 'admin', updated_at = NOW()",
    [token, process.env.ADMIN_USER]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
}));
app.delete('/admin/api/fcm-token', requireAdmin, asyncRoute(async (req, res) => {
  const token = teacherToken(req.body);
  if (!token) return res.status(400).json({ error: 'Geçersiz bildirim kimliği.' });
  await pool.query("DELETE FROM sorbi.teacher_devices WHERE fcm_token = $1 AND owner_name = $2 AND role = 'admin'", [token, process.env.ADMIN_USER]);
  res.json({ success: true });
}));

async function queueTeacherPush(db, eventKey, payload) {
  // Ödeme ve manuel hak olayları yalnızca yöneticiye; matematik soruları iki yetkili role gider.
  await db.query(
    `INSERT INTO sorbi.teacher_push_outbox(event_key, fcm_token, payload)
     SELECT $1, fcm_token, $2::jsonb FROM sorbi.teacher_devices
     WHERE (role = 'admin' AND owner_name = $3)
        OR (role = 'math_teacher' AND owner_name = $4 AND $5 = 'new_question' AND $6 = 'math')
     ON CONFLICT DO NOTHING`,
    [eventKey, JSON.stringify(payload), process.env.ADMIN_USER,
     mathTeacherConfigured() ? process.env.MATH_TEACHER_USER : null, payload.type, payload.subject || '']
  );
}

function teacherMessage(job) {
  const data = job.payload;
  const type = data.type;
  const isQuestion = type === 'new_question';
  const isManual = type === 'credits_granted';
  const testPrefix = data.isTest === 'true' ? 'TEST · ' : '';
  return {
    token: job.fcm_token,
    notification: {
      title: isQuestion ? 'Yeni soru geldi' : isManual ? 'Yeni hak verildi' : testPrefix + 'Ödeme doğrulandı',
      body: isQuestion
        ? (data.subject === 'math' ? 'Matematik' : 'İngilizce') + ' sorusu çözüm bekliyor.'
        : isManual ? 'Bir öğrenciye 15 soru hakkı manuel eklendi.' : 'Ödeme doğrulandı, öğrenciye 15 soru hakkı otomatik eklendi.',
    },
    data,
    android: { priority: 'high', ttl: 86400000, notification: { sound: 'default', tag: job.event_key } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

let teacherPushRunning = false;
async function processTeacherPushes() {
  if (teacherPushRunning) return;
  teacherPushRunning = true;
  try {
    const leaseId = crypto.randomUUID();
    // Atomik kiralama, birden fazla Render örneğinin aynı işi eşzamanlı almasını engeller.
    const claimed = await pool.query(
      `WITH due AS (
        SELECT o.event_key, o.fcm_token FROM sorbi.teacher_push_outbox o
        JOIN sorbi.teacher_devices d ON d.fcm_token = o.fcm_token
        WHERE o.attempts < 8 AND o.next_attempt_at <= NOW()
          AND ((d.role = 'admin' AND d.owner_name = $2)
            OR (d.role = 'math_teacher' AND d.owner_name = $3
              AND o.payload->>'type' = 'new_question' AND o.payload->>'subject' = 'math'))
        ORDER BY o.created_at LIMIT 20 FOR UPDATE OF o SKIP LOCKED
      ) UPDATE sorbi.teacher_push_outbox o
        SET attempts = attempts + 1, next_attempt_at = NOW() + INTERVAL '10 minutes', lease_id = $1
        FROM due WHERE o.event_key = due.event_key AND o.fcm_token = due.fcm_token
        RETURNING o.*`, [leaseId, process.env.ADMIN_USER, mathTeacherConfigured() ? process.env.MATH_TEACHER_USER : null]
    );
    await Promise.all(claimed.rows.map(async job => {
      try {
        await admin.messaging().send(teacherMessage(job));
        await pool.query('DELETE FROM sorbi.teacher_push_outbox WHERE event_key = $1 AND fcm_token = $2 AND lease_id = $3', [job.event_key, job.fcm_token, leaseId]);
      } catch (error) {
        const code = error.code || 'PUSH_RETRY';
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) {
          await pool.query('DELETE FROM sorbi.teacher_devices WHERE fcm_token = $1', [job.fcm_token]);
        } else {
          const delaySeconds = Math.min(21600, 60 * (2 ** Math.min(job.attempts, 8)));
          await pool.query(
            `UPDATE sorbi.teacher_push_outbox SET last_error = $4,
              next_attempt_at = NOW() + ($5 * INTERVAL '1 second')
              WHERE event_key = $1 AND fcm_token = $2 AND lease_id = $3`,
            [job.event_key, job.fcm_token, leaseId, code, delaySeconds]
          );
          console.error('Öğretmen bildirimi yeniden denenecek:', code);
        }
      }
    }));
  } catch (error) {
    console.error('Öğretmen bildirim kuyruğu:', error.code || 'PUSH_QUEUE_ERROR');
  } finally { teacherPushRunning = false; }
}
function startTeacherPushWorker() {
  void processTeacherPushes();
  setInterval(() => { void processTeacherPushes(); }, 15000).unref();
}


function mathTeacherConfigured() {
  return Boolean(process.env.MATH_TEACHER_USER && process.env.MATH_TEACHER_PASSWORD) &&
    !(secureEqual(process.env.MATH_TEACHER_USER, process.env.ADMIN_USER) &&
      secureEqual(process.env.MATH_TEACHER_PASSWORD, process.env.ADMIN_PASSWORD));
}
function requireMathTeacher(req, res, next) {
  if (!mathTeacherConfigured()) return res.status(503).json({ error: 'Matematik hocası hesabı henüz tanımlanmadı.' });
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  let decoded = '';
  try { if (encoded) decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch (_) {}
  const separator = decoded.indexOf(':');
  if (scheme !== 'Basic' || separator < 0 ||
      !secureEqual(decoded.slice(0, separator), process.env.MATH_TEACHER_USER) ||
      !secureEqual(decoded.slice(separator + 1), process.env.MATH_TEACHER_PASSWORD)) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre yanlış.' });
  }
  req.teacherRole = 'math_teacher';
  next();
}
function requireAnswerTeacher(req, res, next) {
  if (req.path.startsWith('/teacher/api/')) return requireMathTeacher(req, res, next);
  req.teacherRole = 'admin';
  return requireAdmin(req, res, next);
}
const requireMathQuestion = asyncRoute(async (req, res, next) => {
  if (req.teacherRole !== 'math_teacher') return next();
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Soru bulunamadı.' });
  const found = await pool.query("SELECT id FROM sorbi.questions WHERE id = $1 AND subject = 'math'", [id]);
  if (!found.rowCount) return res.status(404).json({ error: 'Soru bulunamadı.' });
  next();
});

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function removeUpload(file) {
  if (file) await fs.promises.unlink(file.path).catch(() => {});
}

function safeExtension(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  const mimeExtensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return mimeExtensions[file.mimetype] || ".jpg";
}

async function uploadImageToStorage(file, folder) {
  if (!file) return "";

  const storagePath = `${folder}/${Date.now()}-${crypto.randomUUID()}${safeExtension(file)}`;
  try {
    const contents = await fs.promises.readFile(file.path);
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, contents, {
        contentType: imageContentType(file),
        upsert: false,
      });

    if (error) throw error;

    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    if (!data || !data.publicUrl) {
      throw new Error("Supabase görsel adresi oluşturulamadı.");
    }
    return data.publicUrl;
  } finally {
    await removeUpload(file);
  }
}

async function transaction(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

async function initializeDatabase() {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(724193851)");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS sorbi;
      CREATE TABLE IF NOT EXISTS sorbi.users (
        user_id TEXT PRIMARY KEY,
        paid_credits INTEGER NOT NULL DEFAULT 0 CHECK (paid_credits >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE sorbi.users
ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE sorbi.users
ADD COLUMN IF NOT EXISTS fcm_token TEXT;
      CREATE TABLE IF NOT EXISTS sorbi.questions (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK (id <= 9007199254740991),
        user_id TEXT REFERENCES sorbi.users(user_id),
        file TEXT NOT NULL,
        credit_type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'bekliyor',
        answer TEXT NOT NULL DEFAULT '',
        answer_file TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        answered_at TIMESTAMPTZ
      );
      ALTER TABLE sorbi.questions
ADD COLUMN IF NOT EXISTS feedback TEXT;
      ALTER TABLE sorbi.questions ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'english';
      ALTER TABLE sorbi.questions ADD COLUMN IF NOT EXISTS answered_by TEXT;
      CREATE INDEX IF NOT EXISTS sorbi_questions_user_idx ON sorbi.questions(user_id);
      
      CREATE TABLE IF NOT EXISTS sorbi.play_purchases (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES sorbi.users(user_id),
        product_id TEXT NOT NULL,
        order_id TEXT,
        credits INTEGER NOT NULL CHECK (credits = 15),
        is_test BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sorbi_play_order_idx ON sorbi.play_purchases(order_id) WHERE order_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sorbi.teacher_devices (
        fcm_token TEXT PRIMARY KEY,
        owner_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE sorbi.teacher_devices ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
      CREATE TABLE IF NOT EXISTS sorbi.teacher_push_outbox (
        event_key TEXT NOT NULL,
        fcm_token TEXT NOT NULL REFERENCES sorbi.teacher_devices(fcm_token) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_id TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(event_key, fcm_token)
      );
      CREATE INDEX IF NOT EXISTS teacher_push_due_idx
        ON sorbi.teacher_push_outbox(next_attempt_at) WHERE attempts < 8;
      CREATE TABLE IF NOT EXISTS sorbi.migrations (name TEXT PRIMARY KEY);
    `);

    const done = await client.query(
      "SELECT 1 FROM sorbi.migrations WHERE name = 'legacy_json_v1'"
    );
    if (done.rowCount) return;

    const occupied = await client.query(
      "SELECT EXISTS(SELECT 1 FROM sorbi.users) OR EXISTS(SELECT 1 FROM sorbi.questions) AS occupied"
    );

    if (!occupied.rows[0].occupied) {
      const readLegacy = (name, fallback) => {
        const filename = path.join(__dirname, name);
        if (!fs.existsSync(filename)) return fallback;
        const text = fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "").trim();
        return text ? JSON.parse(text) : fallback;
      };

      const users = readLegacy("users.json", {});
      const questions = readLegacy("questions.json", []);
      if (!users || Array.isArray(users) || typeof users !== "object" || !Array.isArray(questions)) {
        throw new Error("Eski JSON verilerinin biçimi geçersiz.");
      }

      for (const [userId, user] of Object.entries(users)) {
        const credits = Number(user.paidCredits || 0);
        if (!Number.isSafeInteger(credits) || credits < 0) {
          throw new Error("Eski kredi değeri geçersiz.");
        }
        await client.query(
          "INSERT INTO sorbi.users(user_id, paid_credits) VALUES ($1, $2)",
          [userId, credits]
        );
      }

      for (const q of questions) {
        if (!Number.isSafeInteger(Number(q.id)) || Number(q.id) < 1) {
          throw new Error("Eski soru ID değeri geçersiz.");
        }
        const userId = q.userId == null ? null : String(q.userId);
        if (userId !== null) {
          await client.query(
            "INSERT INTO sorbi.users(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
            [userId]
          );
        }
        await client.query(
          `INSERT INTO sorbi.questions
           (id, user_id, file, credit_type, status, answer, answer_file, created_at, answered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            Number(q.id),
            userId,
            q.file || "",
            q.creditType || "",
            q.status || "bekliyor",
            q.answer || "",
            q.answerFile || "",
            q.createdAt || new Date().toISOString(),
            q.answeredAt || null,
          ]
        );
      }

      await client.query(
        "SELECT setval(pg_get_serial_sequence('sorbi.questions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sorbi.questions"
      );
    }

    await client.query(
      "INSERT INTO sorbi.migrations(name) VALUES ('legacy_json_v1')"
    );
  });
}

function questionJson(row) {
  return {
    id: Number(row.id),
    userId: row.user_id,
    file: row.file,
    creditType: row.credit_type,
    status: row.status,
    answer: row.answer,
    answerFile: row.answer_file,
    feedback: row.feedback ?? null,
    subject: row.subject || 'english',
    answeredBy: row.answered_by || null,
    createdAt: new Date(row.created_at).toISOString(),
    answeredAt: row.answered_at ? new Date(row.answered_at).toISOString() : null,
  };
}

async function readQuestions(userId) {
  const result =
    userId === undefined
      ? await pool.query("SELECT * FROM sorbi.questions ORDER BY id")
      : await pool.query(
          "SELECT * FROM sorbi.questions WHERE user_id = $1 ORDER BY id",
          [userId]
        );
  return result.rows.map(questionJson);
}

async function getRightsInfo(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM sorbi.questions WHERE user_id = $1) AS used,
       COALESCE((SELECT paid_credits FROM sorbi.users WHERE user_id = $1), 0) AS paid`,
    [userId]
  );
  const freeRemaining = Math.max(0, FREE_QUESTION_LIMIT - Number(rows[0].used));
  const paidRemaining = Number(rows[0].paid);
  return {
    freeQuestionLimit: FREE_QUESTION_LIMIT,
    freeRemaining,
    paidRemaining,
    totalRemaining: freeRemaining + paidRemaining,
    needsPackage: freeRemaining + paidRemaining <= 0,
  };
}

// Google Play: verification precedes credit delivery; tokens are stored as hashes.
const PLAY_PRODUCT = 'sorbi_15_soru';
const PLAY_PACKAGE = 'com.seyitcorduk.sorbi';
function billingReady() {
  return process.env.PLAY_BILLING_ENABLED === 'true' && !!process.env.PLAY_SERVICE_ACCOUNT;
}
function billingError(status, code) {
  return Object.assign(new Error(code), { status, code });
}
async function playVerificationError(response) {
  let code = 'PLAY_VERIFICATION_UNAVAILABLE';
  if (response.status === 401) code = 'PLAY_AUTH_UNAVAILABLE';
  if (response.status === 403) {
    // Inspect only known reason codes; never expose Google's response body.
    const body = await response.json().catch(() => null);
    const errors = Array.isArray(body?.error?.errors) ? body.error.errors : [];
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    const apiDisabled = [...errors, ...details].some(item =>
      item?.reason === 'SERVICE_DISABLED' || item?.reason === 'accessNotConfigured'
    );
    code = apiDisabled ? 'PLAY_API_DISABLED' : 'PLAY_PERMISSION_DENIED';
  }
  return Object.assign(billingError(503, code), { googleHttpStatus: response.status });
}
function playAccountId(userId) {
  return crypto.createHash('sha256').update('sorbi:' + userId).digest('hex');
}
let playAccessToken;
let playAccessTokenExpires = 0;
async function playAuthorization() {
  if (playAccessToken && Date.now() < playAccessTokenExpires) return playAccessToken;
  const account = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT);
  if (account.client_email !== 'sorbi-play-billing@sorbi-27bfc.iam.gserviceaccount.com') {
    throw billingError(503, 'BILLING_CONFIGURATION');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature }),
  });
  if (!response.ok) {
    throw Object.assign(billingError(503, 'PLAY_AUTH_UNAVAILABLE'), { googleHttpStatus: response.status });
  }
  const result = await response.json();
  if (!result.access_token) throw billingError(503, 'PLAY_AUTH_UNAVAILABLE');
  playAccessToken = result.access_token;
  playAccessTokenExpires = Date.now() + Math.max(0, Number(result.expires_in || 3600) - 120) * 1000;
  return playAccessToken;
}
async function readPlayPurchase(token) {
  const auth = await playAuthorization();
  const response = await fetch('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
    PLAY_PACKAGE + '/purchases/productsv2/tokens/' + encodeURIComponent(token), {
      headers: { Authorization: 'Bearer ' + auth }, signal: AbortSignal.timeout(15000),
    });
  if (response.status === 401) { playAccessToken = null; }
  if (response.status === 400 || response.status === 404 || response.status === 410) {
    throw billingError(400, 'INVALID_PURCHASE');
  }
  if (!response.ok) throw await playVerificationError(response);
  return response.json();
}
function validatePlayPurchase(purchase, userId) {
  const state = purchase.purchaseStateContext?.purchaseState;
  if (state === 'PENDING') throw billingError(409, 'PAYMENT_PENDING');
  if (state !== 'PURCHASED') throw billingError(400, 'PAYMENT_NOT_COMPLETED');
  if (purchase.obfuscatedExternalAccountId !== playAccountId(userId)) {
    throw billingError(403, 'PURCHASE_ACCOUNT_MISMATCH');
  }
  const items = purchase.productLineItem;
  if (!Array.isArray(items) || items.length !== 1 || items[0].productId !== PLAY_PRODUCT) {
    throw billingError(400, 'WRONG_PRODUCT');
  }
  const details = items[0].productOfferDetails || {};
  if ((details.quantity ?? 1) !== 1 || details.rentOfferDetails || details.preorderOfferDetails ||
      (details.refundableQuantity !== undefined && details.refundableQuantity !== 1)) {
    throw billingError(400, 'UNSUPPORTED_PURCHASE');
  }
  return { consumed: details.consumptionState === 'CONSUMPTION_STATE_CONSUMED',
    orderId: purchase.orderId || null, test: !!purchase.testPurchaseContext };
}
async function deliverPlayPurchase(userId, token, purchase) {
  const verified = validatePlayPurchase(purchase, userId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return transaction(async db => {
    // Serializes simultaneous callbacks, including callbacks across server instances.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tokenHash]);
    const existing = await db.query('SELECT user_id FROM sorbi.play_purchases WHERE token_hash = $1', [tokenHash]);
    if (existing.rowCount) {
      if (existing.rows[0].user_id !== userId) throw billingError(403, 'PURCHASE_ACCOUNT_MISMATCH');
      return { alreadyGranted: true, ...await getRightsInfo(userId, db) };
    }
    if (verified.consumed) throw billingError(409, 'CONSUMED_PURCHASE_NOT_RECORDED');
    await db.query('INSERT INTO sorbi.users(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    await db.query(`INSERT INTO sorbi.play_purchases(token_hash, user_id, product_id, order_id, credits, is_test)
      VALUES ($1,$2,$3,$4,15,$5)`, [tokenHash, userId, PLAY_PRODUCT, verified.orderId, verified.test]);
    await db.query('UPDATE sorbi.users SET paid_credits = paid_credits + 15, updated_at = NOW() WHERE user_id = $1', [userId]);
    await queueTeacherPush(db, 'purchase:' + tokenHash, {
      type: 'payment_received', userId, credits: '15', isTest: String(verified.test),
    });
    return { alreadyGranted: false, ...await getRightsInfo(userId, db) };
  });
}
app.get('/billing/config/:userId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^user_[A-Za-z0-9_]{1,120}$/.test(req.params.userId)) return res.status(400).json({error:'INVALID_USER'});
  res.json({ enabled: billingReady(), productId: PLAY_PRODUCT, accountId: playAccountId(req.params.userId) });
});
app.post('/billing/google/verify', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!billingReady()) throw billingError(503, 'BILLING_NOT_READY');
    const { userId, productId, purchaseToken } = req.body || {};
    if (typeof userId !== 'string' || !/^user_[A-Za-z0-9_]{1,120}$/.test(userId) ||
        productId !== PLAY_PRODUCT || typeof purchaseToken !== 'string' || purchaseToken.length < 10 || purchaseToken.length > 4096) {
      throw billingError(400, 'INVALID_REQUEST');
    }
    const purchase = await readPlayPurchase(purchaseToken);
    const result = await deliverPlayPurchase(userId, purchaseToken, purchase);
    res.json({ verified: true, ...result });
    void processTeacherPushes();
  } catch (error) {
    // Never log Google response bodies, purchase tokens or service account material.
    const result = { error: error.status ? error.code : 'VERIFICATION_RETRY' };
    if (Number.isInteger(error.googleHttpStatus) && error.googleHttpStatus >= 100 && error.googleHttpStatus <= 599) {
      result.googleHttpStatus = error.googleHttpStatus;
    }
    console.error('Google Play doğrulama hatası:', JSON.stringify(result));
    res.status(error.status || 503).json(result);
  }
});


app.get("/", (req, res) => res.send("SorBi server çalışıyor"));

app.get(
  "/rights/:userId",
  asyncRoute(async (req, res) => {
    res.json(await getRightsInfo(req.params.userId));
  })
);

app.post(
  "/admin/add-package/:userId",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await transaction(async db => {
    await db.query(
      `INSERT INTO sorbi.users(user_id, paid_credits) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
       SET paid_credits = sorbi.users.paid_credits + EXCLUDED.paid_credits,
           updated_at = NOW()`,
      [req.params.userId, PACKAGE_QUESTION_COUNT]
    );
    await queueTeacherPush(db, 'manual:' + crypto.randomUUID(), {
      type: 'credits_granted', userId: req.params.userId, credits: String(PACKAGE_QUESTION_COUNT),
    });
    });
    res.redirect("/panel");
    void processTeacherPushes();
  })
);
app.post(
  "/feedback/:id",
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const feedback = req.body?.feedback;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Geçersiz soru ID." });
    }

    if (!["helpful", "not_helpful"].includes(feedback)) {
      return res.status(400).json({ error: "Geçersiz geri bildirim." });
    }

    const result = await pool.query(
      `UPDATE sorbi.questions
       SET feedback = $2
       WHERE id = $1
       RETURNING id`,
      [id, feedback]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Soru bulunamadı." });
    }

    res.json({ success: true });
  })
);
app.post(
  "/user/display-name/:userId",
  asyncRoute(async (req, res) => {
    const userId = req.params.userId;
    const displayName = req.body.displayName?.toString().trim();

    if (!displayName) {
      return res.status(400).json({ error: "İsim boş bırakılamaz." });
    }

    await pool.query(
      `INSERT INTO sorbi.users(user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           updated_at = NOW()`,
      [userId, displayName]
    );

    res.json({
      success: true,
      displayName
    });
  })
);
app.post(
  "/user/fcm-token/:userId",
  asyncRoute(async (req, res) => {
    const userId = req.params.userId;
    const fcmToken = req.body.fcmToken?.toString().trim();

    if (!fcmToken) {
      return res.status(400).json({ error: "FCM token boş." });
    }

    await pool.query(
      `INSERT INTO sorbi.users(user_id, fcm_token)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET fcm_token = EXCLUDED.fcm_token,
           updated_at = NOW()`,
      [userId, fcmToken]
    );

    res.json({ success: true });
  })
);
app.post(
  "/solve",
  questionUpload.single("image"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Soru fotoğrafı bulunamadı." });
    }

    const userId = req.body.userId?.toString();
    if (!userId) {
      await removeUpload(req.file);
      return res.status(400).json({ error: "Kullanıcı ID bulunamadı." });
    }

    const subject = req.body.subject || 'english';
    if (!["english", "math"].includes(subject)) {
      await removeUpload(req.file);
      return res.status(400).json({ error: "Geçersiz ders." });
    }
    let result;
    try {
      result = await transaction(async client => {
        await client.query(
          "INSERT INTO sorbi.users(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [userId]
        );
        await client.query(
          "SELECT user_id FROM sorbi.users WHERE user_id = $1 FOR UPDATE",
          [userId]
        );

        const rights = await getRightsInfo(userId, client);
        if (rights.needsPackage) return null;

        const creditType = rights.freeRemaining > 0 ? "free" : "paid";
        if (creditType === "paid") {
          await client.query(
            "UPDATE sorbi.users SET paid_credits = paid_credits - 1, updated_at = NOW() WHERE user_id = $1",
            [userId]
          );
        }

        const questionImageUrl = await uploadImageToStorage(req.file, "questions");
        const saved = await client.query(
          `INSERT INTO sorbi.questions(user_id, file, credit_type, subject)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [userId, questionImageUrl, creditType, subject]
        );

        await queueTeacherPush(client, 'question:' + saved.rows[0].id, {
          type: 'new_question', subject, questionId: String(saved.rows[0].id),
        });
        return {
          result: "Sorun hocana ulaştı.",
          id: Number(saved.rows[0].id),
          creditType,
          ...(await getRightsInfo(userId, client)),
        };
      });
    } catch (error) {
      await removeUpload(req.file);
      throw error;
    }

    if (!result) {
      await removeUpload(req.file);
      return res.status(403).json({
        error: "Ücretsiz soru hakkın bitti. Yeni paket satın almalısın.",
        code: "PACKAGE_REQUIRED",
        freeRemaining: 0,
        paidRemaining: 0,
        totalRemaining: 0,
      });
    }

    res.json(result);
    void processTeacherPushes();
  })
);

app.get(
  "/questions/:userId",
  asyncRoute(async (req, res) => res.json(await readQuestions(req.params.userId)))
);
app.get(
  "/questions",
  requireAdmin,
  asyncRoute(async (req, res) => res.json(await readQuestions()))
);

app.post(
  ["/panel-answer/:id", "/admin/api/answer/:id", "/teacher/api/answer/:id"],
  requireAnswerTeacher,
  requireMathQuestion,
  answerUpload.single("answerFile"),
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      await removeUpload(req.file);
      return res.status(404).json({ error: "Soru bulunamadı." });
    }

    const existing = await pool.query(
      "SELECT id, answer, answer_file FROM sorbi.questions WHERE id = $1 AND ($2::boolean = FALSE OR subject = 'math')",
      [id, req.teacherRole === 'math_teacher']
    );
    if (!existing.rowCount) {
      await removeUpload(req.file);
      return res.status(404).send("Soru bulunamadı");
    }

    const answer = req.body.answer?.toString().trim() || "";
    if (!answer && !req.file) {
      return res.status(400).json({ error: "Yazılı cevap veya çözüm fotoğrafı gerekli." });
    }
    const answerImageUrl = req.file
      ? await uploadImageToStorage(req.file, "answers")
      : "";

    const updated = await pool.query(
      `UPDATE sorbi.questions SET
         answer = CASE WHEN $2 <> '' THEN $2 ELSE answer END,
         answer_file = CASE WHEN $3 <> '' THEN $3 ELSE answer_file END,
         status = 'cevaplandı', answered_at = NOW(), answered_by = $4,
         feedback = CASE WHEN ($2 <> '' AND $2 IS DISTINCT FROM answer) OR $3 <> '' THEN NULL ELSE feedback END
       WHERE id = $1 AND ($5::boolean = FALSE OR subject = 'math') RETURNING id`,
      [id, answer, answerImageUrl, req.teacherRole === 'math_teacher' ? 'math_teacher' : 'admin', req.teacherRole === 'math_teacher']
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'Soru bulunamadı.' });
const tokenResult = await pool.query(
  `SELECT u.fcm_token
   FROM sorbi.questions q
   JOIN sorbi.users u ON u.user_id = q.user_id
   WHERE q.id = $1`,
  [id]
);

const fcmToken = tokenResult.rows[0]?.fcm_token;
    try {
  if (fcmToken) {
    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: "SorBi",
        body: "Sorunun cevaplandı 🎉",
      },
      data: {
        questionId: String(id),
      },
    });

    console.log("Bildirim gönderildi:", id);
  }
} catch (error) {
  console.error("Bildirim gönderilemedi:", error.message);
}
    if (req.path.startsWith("/admin/api/") || req.path.startsWith("/teacher/api/")) return res.json({ success: true });
    res.redirect("/panel");
  })
);

function cleanUploadPath(filePath) {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const uploadsIndex = normalized.lastIndexOf("/uploads/");
  if (uploadsIndex !== -1) return normalized.substring(uploadsIndex + 1);
  if (normalized.startsWith("uploads/")) return normalized;
  return `uploads/${path.basename(normalized)}`;
}
app.post(
  "/admin/delete-question/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).send("Geçersiz soru ID");
    }

    const result = await pool.query(
      "DELETE FROM sorbi.questions WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).send("Soru bulunamadı");
    }

    res.redirect("/panel");
  })
);
function cleanAnswerPath(filePath) {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const answersIndex = normalized.lastIndexOf("/answers/");
  if (answersIndex !== -1) return normalized.substring(answersIndex + 1);
  if (normalized.startsWith("answers/")) return normalized;
  return `answers/${path.basename(normalized)}`;
}

function fileToUrl(filePath, type) {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  const cleanPath =
    type === "answer" ? cleanAnswerPath(filePath) : cleanUploadPath(filePath);
  return `/${cleanPath}`;
}

app.get(
  "/panel",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const questions = (await readQuestions()).slice().reverse();
    const balanceRows = await pool.query(
      "SELECT user_id, paid_credits, display_name FROM sorbi.users"
    );
    const balances = new Map(
      balanceRows.rows.map(user => [user.user_id, user.paid_credits])
    );
const displayNames = new Map(
  balanceRows.rows.map(user => [user.user_id, user.display_name])
);
    const groupedQuestions = new Map();
    questions.forEach(question => {
      const key = question.userId || "__legacy__";
      if (!groupedQuestions.has(key)) groupedQuestions.set(key, []);
      groupedQuestions.get(key).push(question);
    });

    const groups = Array.from(groupedQuestions.entries()).map(
      ([key, userQuestions], index) => {
        const userId = key === "__legacy__" ? "" : key;
        return {
          userId,
          label: userId
  ? (displayNames.get(userId) || `Kullanıcı ${index + 1}`)
  : "Eski sorular",
          questions: userQuestions,
          waiting: userQuestions.filter(q => q.status !== "cevaplandı").length,
          done: userQuestions.filter(q => q.status === "cevaplandı").length,
          paidCredits: userId ? Number(balances.get(userId) || 0) : 0,
        };
      }
    );
    const waitingTotal = groups.reduce((sum, group) => sum + group.waiting, 0);

    let html = `
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SorBi Hoca Paneli</title>
<style>
* { box-sizing: border-box; }
body { font-family: Arial, sans-serif; background: #f5f4fa; margin: 0; padding: 25px; }
.container { max-width: 950px; margin: 0 auto; }
h1 { color: #6547d8; }
.card { background: white; padding: 22px; margin-bottom: 22px; border-radius: 18px; box-shadow: 0 3px 14px rgba(0,0,0,0.08); }
.top-row { display: flex; justify-content: space-between; gap: 15px; flex-wrap: wrap; }
.user { color: #555; }
.rights { background: #eeeafe; padding: 12px; border-radius: 10px; margin-top: 10px; }
.status { font-weight: bold; }
.status.waiting { color: #e89400; }
.status.done { color: #159957; }
.question-image, .answer-image { display: block; max-width: 500px; width: 100%; max-height: 600px; object-fit: contain; border-radius: 12px; margin-top: 12px; border: 1px solid #eee; }
textarea { width: 100%; min-height: 110px; margin-top: 15px; padding: 12px; border-radius: 10px; border: 1px solid #ccc; font-size: 16px; }
button { margin-top: 15px; padding: 12px 20px; background: #7057e8; color: white; border: none; border-radius: 10px; cursor: pointer; }
.package-button { background: #19172a; }
.existing-answer { background: #f2efff; padding: 14px; border-radius: 10px; margin-top: 18px; }
.panel-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 18px 0 24px; }
.stat { background: white; border-radius: 14px; padding: 16px; box-shadow: 0 3px 14px rgba(0,0,0,0.06); }
.stat strong { display: block; color: #6547d8; font-size: 26px; margin-bottom: 4px; }
.stat span { color: #666; font-size: 14px; }
.user-group { background: #ebe7ff; border: 1px solid #ddd6ff; border-radius: 18px; margin-bottom: 18px; overflow: hidden; }
.user-group.has-waiting {
  background: #ffe5e5;
  border: 2px solid #e53935;
}

.user-group.all-done {
  background: #ffffff;
  border: 1px solid #e2e2e2;
}
.user-group > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px; cursor: pointer; list-style: none; }
.user-group > summary::-webkit-details-marker { display: none; }
.user-group > summary strong { display: block; color: #2b234f; font-size: 20px; }
.user-code { display: block; color: #746d91; font-size: 13px; margin-top: 4px; }
.summary-right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.badge { border-radius: 999px; padding: 6px 10px; font-size: 13px; font-weight: bold; white-space: nowrap; }
.badge.waiting { background: #fff3d8; color: #b36b00; }
.badge.done { background: #dcf7e8; color: #147744; }
.chevron { color: #6547d8; font-size: 24px; transition: transform .2s ease; }
.user-group[open] .chevron { transform: rotate(180deg); }
.group-tools { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: white; border-top: 1px solid #e5e0ff; padding: 14px 20px; }
.group-tools span { display: block; color: #777; font-size: 12px; margin-bottom: 4px; }
.group-tools code { color: #3b3458; overflow-wrap: anywhere; }
.group-tools form, .group-tools button { margin: 0; }
.question-list { padding: 18px; }
.question-list .card:last-child { margin-bottom: 0; }
@media (max-width: 600px) {
  body { padding: 14px; }
  h1 { font-size: 26px; }
  .panel-stats { grid-template-columns: 1fr; gap: 8px; }
  .stat { display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; }
  .stat strong { margin: 0; font-size: 22px; }
  .user-group > summary { align-items: flex-start; padding: 15px; }
  .summary-right { max-width: 170px; }
  .group-tools, .question-list { padding: 12px; }
  .card { padding: 16px; }
}
</style>
</head>
<body>
<div class="container">
<h1>SorBi - Hoca Paneli</h1>
<div class="panel-stats">
<div class="stat"><strong>${groups.length}</strong><span>Kullanıcı</span></div>
<div class="stat"><strong>${questions.length}</strong><span>Toplam soru</span></div>
<div class="stat"><strong>${waitingTotal}</strong><span>Bekleyen soru</span></div>
</div>
`;

    if (questions.length === 0) {
      html += "<p>Henüz soru yok.</p>";
    }

    groups.forEach((group, groupIndex) => {
      const shortId = group.userId ? group.userId.slice(-8) : "kayıtsız";
      html += `
<details class="user-group ${group.waiting > 0 ? "has-waiting" : "all-done"}"${groupIndex === 0 ? " open" : ""}>
<summary>
<div>
<strong>${escapeHtml(group.label)}</strong>
<span class="user-code">Kod: ${escapeHtml(shortId)}</span>
</div>
<div class="summary-right">
<span class="badge waiting">${group.waiting} bekliyor</span>
<span class="badge done">${group.done} cevaplandı</span>
<span class="chevron">⌃</span>
</div>
</summary>
<div class="group-tools">
<div><span>Tam kullanıcı kimliği</span><code>${escapeHtml(group.userId || "Eski kayıt")}</code></div>
`;

      if (group.userId) {
        html += `
<div>
<span>Paket soru hakkı: <strong>${group.paidCredits}</strong></span>
<form action="/admin/add-package/${encodeURIComponent(group.userId)}" method="POST">
<button class="package-button" type="submit">+15 Soru Hakkı Ver</button>
</form>
</div>
`;
      }

      html += "</div><div class=\"question-list\">";
group.questions.forEach((q, questionIndex) => {
        const userQuestionNumber = group.questions.length - questionIndex;
        const questionImage = fileToUrl(q.file, "question");
        const answerImage = q.answerFile ? fileToUrl(q.answerFile, "answer") : "";
        const statusClass = q.status === "cevaplandı" ? "done" : "waiting";

        html += `
<div class="card">
<div class="top-row">
<div>
<h2>Soru ${userQuestionNumber}</h2>
<p class="user">${escapeHtml(group.label)} · ${new Date(q.createdAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}</p>
`;


      html += `
</div>
<p class="status ${statusClass}">${escapeHtml(q.status)}</p>
</div>
<p><strong>Gönderilen soru</strong></p>
<img class="question-image" src="${escapeHtml(questionImage)}" alt="Soru fotoğrafı">
<form action="/panel-answer/${q.id}" method="POST" enctype="multipart/form-data">
<textarea name="answer" placeholder="Cevabı buraya yaz...">${escapeHtml(q.answer || "")}</textarea>
<br><br>
<label><strong>Çözüm fotoğrafı:</strong></label>
<br>
<input type="file" name="answerFile" accept="image/*">
<br>
<button type="submit">Cevabı Kaydet</button>
</form>
${q.feedback === "helpful"
  ? "<p><strong>Öğrenci geri bildirimi:</strong> 👍 Faydalı</p>"
  : q.feedback === "not_helpful"
    ? "<p><strong>Öğrenci geri bildirimi:</strong> 👎 Yetersiz</p>"
    : "<p><strong>Öğrenci geri bildirimi:</strong> Henüz yok</p>"
}
<form action="/admin/delete-question/${q.id}" method="POST"
      onsubmit="return confirm('Bu soruyu silmek istediğine emin misin?');">
  <button type="submit"
          style="background:#d93025; margin-top:10px;">
    🗑️ Soruyu Sil
  </button>
</form>
`;

      if (q.answer) {
        html += `
<div class="existing-answer">
<strong>Mevcut yazılı cevap:</strong>
<br><br>
${escapeHtml(q.answer)}
</div>
`;
      }

      if (answerImage) {
        html += `
<p><strong>Mevcut çözüm fotoğrafı</strong></p>
<img class="answer-image" src="${escapeHtml(answerImage)}" alt="Çözüm fotoğrafı">
`;
      }

        html += "</div>";
      });

      html += "</div></details>";
    });

    html += "</div></body></html>";
    res.send(html);
  })
);


function mathTeacherStats(questions) {
  const math = questions.filter(q => q.subject === "math");
  const solved = math.filter(q => q.status === "cevaplandı" && q.answeredBy === "math_teacher");
  return {
    solved: solved.length,
    helpful: solved.filter(q => q.feedback === "helpful").length,
    notHelpful: solved.filter(q => q.feedback === "not_helpful").length,
    unrated: solved.filter(q => !["helpful", "not_helpful"].includes(q.feedback)).length,
    waiting: math.filter(q => q.status !== "cevaplandı").length,
    unattributed: math.filter(q => q.status === "cevaplandı" && !q.answeredBy).length,
  };
}


app.post('/teacher/api/fcm-token', requireMathTeacher, asyncRoute(async (req, res) => {
  const token = teacherToken(req.body);
  if (!token) return res.status(400).json({ error: 'Geçersiz bildirim kimliği.' });
  await pool.query(
    `INSERT INTO sorbi.teacher_devices(fcm_token, owner_name, role) VALUES ($1,$2,'math_teacher')
       ON CONFLICT (fcm_token) DO UPDATE SET owner_name = EXCLUDED.owner_name, role = 'math_teacher', updated_at = NOW()`,
    [token, process.env.MATH_TEACHER_USER]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
}));
app.delete('/teacher/api/fcm-token', requireMathTeacher, asyncRoute(async (req, res) => {
  const token = teacherToken(req.body);
  if (!token) return res.status(400).json({ error: 'Geçersiz bildirim kimliği.' });
  await pool.query("DELETE FROM sorbi.teacher_devices WHERE fcm_token = $1 AND owner_name = $2 AND role = 'math_teacher'", [token, process.env.MATH_TEACHER_USER]);
  res.json({ success: true });
}));
app.get('/teacher/api/dashboard', requireMathTeacher, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT q.*, u.display_name FROM sorbi.questions q LEFT JOIN sorbi.users u ON u.user_id = q.user_id WHERE q.subject = 'math' ORDER BY q.id DESC"
  );
  const questions = result.rows.map(row => ({ ...questionJson(row), displayName: row.display_name || '' }));
  res.set('Cache-Control', 'no-store');
  res.json({ questions, mathTeacher: mathTeacherStats(questions) });
}));

app.get("/admin/api/dashboard", requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT q.*, u.display_name FROM sorbi.questions q LEFT JOIN sorbi.users u ON u.user_id = q.user_id ORDER BY q.id DESC"
  );
  const questions = result.rows.map(row => ({ ...questionJson(row), displayName: row.display_name || "" }));
  res.set("Cache-Control", "no-store");
  const purchases = await pool.query(
    'SELECT p.order_id AS "orderId", p.product_id AS "productId", p.credits, p.is_test AS "isTest", p.created_at AS "createdAt", COALESCE(u.display_name, p.user_id) AS "displayName" FROM sorbi.play_purchases p JOIN sorbi.users u ON u.user_id = p.user_id ORDER BY p.created_at DESC LIMIT 100'
  );
  res.json({ questions, mathTeacher: mathTeacherStats(questions), billingConnected: billingReady(), purchases: purchases.rows });
}));

app.use((error, req, res, next) => {
  console.error(
    "İşlem hatası:",
    error.code || error.name || "SERVER_ERROR",
    error.message || "");
    if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "Fotoğraf en fazla 10 MB olabilir." });
  }
  if (req.path === "/panel") return res.status(500).send("Panel yüklenemedi");
  if (req.path.startsWith("/panel-answer/")) {
    return res.status(500).send("Cevap kaydedilemedi");
  }
  if (req.path.startsWith("/admin/add-package/")) {
    return res.status(500).send("Paket eklenemedi");
  }

  const message = req.path.startsWith("/rights/")
    ? "Hak bilgisi alınamadı."
    : req.path.startsWith("/questions")
      ? "Sorular yüklenemedi."
      : "Sunucu hatası oluştu.";

  res.status(500).json({ error: message });
});
app.get("/privacy", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SorBi Gizlilik Politikası</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #f8f7fc;
      color: #25222e;
      font-family: Arial, sans-serif;
      line-height: 1.65;
    }
    main {
      max-width: 820px;
      margin: auto;
      padding: 28px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
    }
    h1, h2 { color: #7057e8; }
    a { color: #5840c9; }
  </style>
</head>
<body>
<main>
  <h1>SorBi Gizlilik Politikası</h1>
  <p><strong>Son güncelleme:</strong> 20 Eylül 2026</p>

  <p>
    Bu gizlilik politikası, Seyit Çördük tarafından sunulan SorBi
    uygulamasında kullanıcı verilerinin nasıl işlendiğini açıklar.
  </p>

  <h2>Toplanan veriler</h2>
  <ul>
    <li>Uygulamanın oluşturduğu rastgele kullanıcı kimliği.</li>
    <li>Kullanıcının gönderdiği soru görselleri.</li>
    <li>Sorulara ait cevap, durum ve tarih bilgileri.</li>
    <li>Ücretsiz ve paket soru hakkı bilgileri.</li>
    <li>Güvenlik ve hata tespiti için gerekli teknik sunucu kayıtları.</li>
  </ul>

  <p>
    SorBi; reklam kimliği, kesin konum, rehber, sağlık veya finansal
    bilgileri bilerek toplamaz. Kullanıcıların gönderdikleri görsellerde
    kişisel bilgi bulundurmamaları önerilir.
  </p>

  <h2>Verilerin kullanım amaçları</h2>
  <ul>
    <li>Gönderilen soruları öğretmene ulaştırmak ve cevaplamak.</li>
    <li>Kullanıcının soru ve cevap geçmişini göstermek.</li>
    <li>Soru haklarını yönetmek.</li>
    <li>Hizmetin güvenliğini sağlamak ve teknik sorunları gidermek.</li>
  </ul>

  <h2>Hizmet sağlayıcılar</h2>
  <p>
    Veriler, uygulamanın çalışması amacıyla Render ve Supabase gibi
    altyapı hizmetlerinde işlenebilir ve saklanabilir. Veriler satılmaz
    veya reklam amacıyla üçüncü taraflarla paylaşılmaz. Yasal bir
    zorunluluk bulunması hâlinde yetkili kurumlarla paylaşım yapılabilir.
  </p>

  <h2>Verilerin saklanması ve silinmesi</h2>
  <p>
    Veriler, hizmetin sunulması için gerekli olduğu sürece saklanır.
    Kullanıcılar soru görsellerinin ve ilgili kayıtlarının silinmesini
    aşağıdaki e-posta adresinden talep edebilir.
  </p>

  <h2>Güvenlik</h2>
  <p>
    Verilerin korunması için makul teknik ve idari önlemler uygulanır.
    İnternet üzerinden gerçekleştirilen hiçbir aktarım yönteminin yüzde
    yüz güvenli olduğu garanti edilemez.
  </p>

  <h2>Çocukların gizliliği</h2>
  <p>
    SorBi özellikle 13 yaşın altındaki çocuklara yönelik değildir.
    13 yaşından küçük bir çocuğa ait verinin gönderildiği fark edilirse,
    veli veya yasal temsilci silme talebinde bulunabilir.
  </p>

  <h2>Politika değişiklikleri</h2>
  <p>
    Bu politika gerektiğinde güncellenebilir. Güncel metin her zaman bu
    sayfada yayımlanır.
  </p>

  <h2>İletişim</h2>
  <p>
    Gizlilik ve veri silme talepleri için:
    <a href="mailto:seyit.crdk12@gmail.com">seyit.crdk12@gmail.com</a>
  </p>
</main>
</body>
</html>
  `);
});
initializeDatabase()
  .then(() => {
    startTeacherPushWorker();
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`SorBi server çalışıyor: ${PORT}`)
    );
  })
  .catch(async error => {
    console.error(
      "Veritabanı başlatılamadı:",
      error.code || error.name,
      "DATABASE_URL bağlantısını ve tablo oluşturma yetkisini kontrol edin."
    );
    await pool.end();
    process.exitCode = 1;
  });

