"use strict";

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");

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
      CREATE INDEX IF NOT EXISTS sorbi_questions_user_idx ON sorbi.questions(user_id);
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

app.get("/", (req, res) => res.send("SorBi server çalışıyor"));

app.get(
  "/rights/:userId",
  asyncRoute(async (req, res) => {
    res.json(await getRightsInfo(req.params.userId));
  })
);

app.post(
  "/admin/add-package/:userId",
  asyncRoute(async (req, res) => {
    await pool.query(
      `INSERT INTO sorbi.users(user_id, paid_credits) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
       SET paid_credits = sorbi.users.paid_credits + EXCLUDED.paid_credits,
           updated_at = NOW()`,
      [req.params.userId, PACKAGE_QUESTION_COUNT]
    );
    res.redirect("/panel");
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
          `INSERT INTO sorbi.questions(user_id, file, credit_type)
           VALUES ($1,$2,$3) RETURNING id`,
          [userId, questionImageUrl, creditType]
        );

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
  })
);

app.get(
  "/questions/:userId",
  asyncRoute(async (req, res) => res.json(await readQuestions(req.params.userId)))
);
app.get(
  "/questions",
  asyncRoute(async (req, res) => res.json(await readQuestions()))
);

app.post(
  "/panel-answer/:id",
  answerUpload.single("answerFile"),
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      await removeUpload(req.file);
      return res.status(404).send("Soru bulunamadı");
    }

    const existing = await pool.query(
      "SELECT id FROM sorbi.questions WHERE id = $1",
      [id]
    );
    if (!existing.rowCount) {
      await removeUpload(req.file);
      return res.status(404).send("Soru bulunamadı");
    }

    const answer = req.body.answer?.toString().trim() || "";
    const answerImageUrl = req.file
      ? await uploadImageToStorage(req.file, "answers")
      : "";

    await pool.query(
      `UPDATE sorbi.questions SET
         answer = CASE WHEN $2 <> '' THEN $2 ELSE answer END,
         answer_file = CASE WHEN $3 <> '' THEN $3 ELSE answer_file END,
         status = 'cevaplandı', answered_at = NOW()
       WHERE id = $1`,
      [id, answer, answerImageUrl]
    );

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
  asyncRoute(async (req, res) => {
    const questions = (await readQuestions()).slice().reverse();
    const balanceRows = await pool.query(
      "SELECT user_id, paid_credits FROM sorbi.users"
    );
    const balances = new Map(
      balanceRows.rows.map(user => [user.user_id, user.paid_credits])
    );

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
</style>
</head>
<body>
<div class="container">
<h1>SorBi - Hoca Paneli</h1>
`;

    if (questions.length === 0) {
      html += "<p>Henüz soru yok.</p>";
    }

    questions.forEach(q => {
      const questionImage = fileToUrl(q.file, "question");
      const answerImage = q.answerFile ? fileToUrl(q.answerFile, "answer") : "";
      const statusClass = q.status === "cevaplandı" ? "done" : "waiting";
      const userId = q.userId || "";
      const paidCredits = userId ? balances.get(userId) || 0 : 0;

      html += `
<div class="card">
<div class="top-row">
<div>
<h2>Soru ID: ${q.id}</h2>
<p class="user">Kullanıcı: <strong>${escapeHtml(userId || "Eski soru")}</strong></p>
`;

      if (userId) {
        html += `
<div class="rights">
<strong>Paket soru hakkı: ${paidCredits}</strong>
<form action="/admin/add-package/${encodeURIComponent(userId)}" method="POST">
<button class="package-button" type="submit">+15 Soru Hakkı Ver</button>
</form>
</div>
`;
      }

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

    html += "</div></body></html>";
    res.send(html);
  })
);

app.use((error, req, res, next) => {
  console.error(
    "İşlem hatası:",
    error.code || error.name || "SERVER_ERROR",
    error.message || ""
  );
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

initializeDatabase()
  .then(() => {
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