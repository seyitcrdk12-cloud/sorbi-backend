const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");
const answersDir = path.join(__dirname, "answers");
const questionsFile = path.join(__dirname, "questions.json");

// ----------------------------------------------------
// KLASÖRLER
// ----------------------------------------------------

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(answersDir)) {
  fs.mkdirSync(answersDir, { recursive: true });
}

if (!fs.existsSync(questionsFile)) {
  fs.writeFileSync(
    questionsFile,
    JSON.stringify([], null, 2),
    "utf8"
  );
}

// ----------------------------------------------------
// MULTER
// ----------------------------------------------------

const questionUpload = multer({
  dest: uploadsDir,
});

const answerUpload = multer({
  dest: answersDir,
});

// ----------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------

app.use(cors());

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(
  "/uploads",
  express.static(uploadsDir)
);

app.use(
  "/answers",
  express.static(answersDir)
);

// ----------------------------------------------------
// YARDIMCI FONKSİYONLAR
// ----------------------------------------------------

function readQuestions() {
  try {
    const data = fs.readFileSync(
      questionsFile,
      "utf8"
    );

    if (!data.trim()) {
      return [];
    }

    return JSON.parse(data);
  } catch (error) {
    console.error(
      "questions.json okuma hatası:",
      error
    );

    return [];
  }
}

function writeQuestions(questions) {
  fs.writeFileSync(
    questionsFile,
    JSON.stringify(
      questions,
      null,
      2
    ),
    "utf8"
  );
}

// Windows tam yolunu temizler.
// Örn:
// C:/Users/asus/yds_backend/uploads/abc
// ->
// uploads/abc

function cleanUploadPath(filePath) {
  if (!filePath) {
    return "";
  }

  const normalized = filePath.replace(/\\/g, "/");

  const uploadsIndex =
    normalized.lastIndexOf("/uploads/");

  if (uploadsIndex !== -1) {
    return normalized.substring(
      uploadsIndex + 1
    );
  }

  if (normalized.startsWith("uploads/")) {
    return normalized;
  }

  return `uploads/${path.basename(normalized)}`;
}

function cleanAnswerPath(filePath) {
  if (!filePath) {
    return "";
  }

  const normalized = filePath.replace(/\\/g, "/");

  const answersIndex =
    normalized.lastIndexOf("/answers/");

  if (answersIndex !== -1) {
    return normalized.substring(
      answersIndex + 1
    );
  }

  if (normalized.startsWith("answers/")) {
    return normalized;
  }

  return `answers/${path.basename(normalized)}`;
}

function fileToUrl(filePath, type) {
  if (!filePath) {
    return "";
  }

  const cleanPath =
    type === "answer"
      ? cleanAnswerPath(filePath)
      : cleanUploadPath(filePath);

  return `/${cleanPath}`;
}

// ----------------------------------------------------
// ANA SAYFA
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.send("SorBi server çalışıyor");
});

// ----------------------------------------------------
// YENİ SORU GÖNDER
// ----------------------------------------------------

app.post(
  "/solve",
  questionUpload.single("image"),
  (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "Soru fotoğrafı bulunamadı.",
          });
      }

      const userId =
        req.body.userId?.toString();

      if (!userId) {
        return res
          .status(400)
          .json({
            error:
              "Kullanıcı ID bulunamadı.",
          });
      }

      const questions =
        readQuestions();

      const newQuestion = {
        id: Date.now(),

        userId: userId,

        // Burada artık tam Windows yolunu değil
        // sadece uploads/... kaydediyoruz.
        file:
          cleanUploadPath(
            req.file.path
          ),

        status: "bekliyor",

        answer: "",

        answerFile: "",

        createdAt:
          new Date().toISOString(),

        answeredAt: null,
      };

      questions.push(
        newQuestion
      );

      writeQuestions(
        questions
      );

      console.log(
        "Yeni soru geldi:",
        newQuestion.id,
        "Kullanıcı:",
        userId,
        "Dosya:",
        newQuestion.file
      );

      return res.json({
        result:
          "Sorun hocana ulaştı.",
        id: newQuestion.id,
      });
    } catch (error) {
      console.error(
        "Soru gönderme hatası:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Sunucu hatası oluştu.",
        });
    }
  }
);

// ----------------------------------------------------
// BELİRLİ KULLANICININ SORULARI
// ----------------------------------------------------

app.get(
  "/questions/:userId",
  (req, res) => {
    try {
      const userId =
        req.params.userId;

      const questions =
        readQuestions();

      const userQuestions =
        questions.filter(
          (q) =>
            q.userId === userId
        );

      return res.json(
        userQuestions
      );
    } catch (error) {
      console.error(
        "Sorular yüklenemedi:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Sorular yüklenemedi.",
        });
    }
  }
);

// ----------------------------------------------------
// TÜM SORULAR
// ----------------------------------------------------

app.get(
  "/questions",
  (req, res) => {
    res.json(
      readQuestions()
    );
  }
);

// ----------------------------------------------------
// HOCA CEVAP KAYDET
// ----------------------------------------------------

app.post(
  "/panel-answer/:id",
  answerUpload.single(
    "answerFile"
  ),
  (req, res) => {
    try {
      const id =
        Number(
          req.params.id
        );

      const questions =
        readQuestions();

      const question =
        questions.find(
          (q) =>
            Number(q.id) === id
        );

      if (!question) {
        return res
          .status(404)
          .send(
            "Soru bulunamadı"
          );
      }

      const textAnswer =
        req.body.answer
          ?.toString()
          .trim();

      if (textAnswer) {
        question.answer =
          textAnswer;
      }

      if (req.file) {
        question.answerFile =
          cleanAnswerPath(
            req.file.path
          );
      }

      question.status =
        "cevaplandı";

      question.answeredAt =
        new Date().toISOString();

      writeQuestions(
        questions
      );

      return res.redirect(
        "/panel"
      );
    } catch (error) {
      console.error(
        "Cevap kaydetme hatası:",
        error
      );

      return res
        .status(500)
        .send(
          "Cevap kaydedilemedi"
        );
    }
  }
);

// ----------------------------------------------------
// HOCA PANELİ
// ----------------------------------------------------

app.get(
  "/panel",
  (req, res) => {
    const questions =
      readQuestions()
        .slice()
        .reverse();

    let html = `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>SorBi Hoca Paneli</title>

<style>

* {
  box-sizing: border-box;
}

body {
  font-family:
    Arial,
    sans-serif;

  background:
    #f5f4fa;

  margin: 0;

  padding: 25px;
}

.container {
  max-width: 950px;
  margin: 0 auto;
}

h1 {
  color: #6547d8;
  margin-bottom: 25px;
}

.card {
  background: white;

  padding: 22px;

  margin-bottom: 22px;

  border-radius: 18px;

  box-shadow:
    0 3px 14px
    rgba(0,0,0,0.08);
}

.top-row {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  flex-wrap: wrap;
}

.question-id {
  margin: 0;
}

.user {
  color: #555;
}

.status {
  font-weight: bold;
}

.status.waiting {
  color: #e89400;
}

.status.done {
  color: #159957;
}

.image-title {
  margin-top: 18px;
  font-weight: bold;
}

.question-image {
  display: block;

  max-width: 500px;

  width: 100%;

  max-height: 600px;

  object-fit: contain;

  border-radius: 12px;

  margin-top: 12px;

  border:
    1px solid #eee;
}

.answer-image {
  display: block;

  max-width: 500px;

  width: 100%;

  max-height: 600px;

  object-fit: contain;

  border-radius: 12px;

  margin-top: 10px;

  border:
    1px solid #eee;
}

textarea {
  width: 100%;

  min-height: 110px;

  margin-top: 15px;

  padding: 12px;

  border-radius: 10px;

  border:
    1px solid #ccc;

  font-size: 16px;

  resize: vertical;
}

input[type="file"] {
  margin-top: 8px;
}

button {
  margin-top: 15px;

  padding:
    12px 20px;

  background:
    #7057e8;

  color: white;

  border: none;

  border-radius: 10px;

  cursor: pointer;

  font-size: 15px;
}

button:hover {
  background:
    #5f45cf;
}

.existing-answer {
  background:
    #f2efff;

  padding: 14px;

  border-radius: 10px;

  margin-top: 18px;
}

</style>

</head>

<body>

<div class="container">

<h1>
SorBi - Hoca Paneli
</h1>
`;

    if (
      questions.length === 0
    ) {
      html += `
<p>
Henüz soru yok.
</p>
`;
    }

    questions.forEach(
      (q) => {

        // Eski questions.json kayıtlarında
        // tam Windows yolu varsa onu da temizler.
        const questionImage =
          fileToUrl(
            q.file,
            "question"
          );

        const answerImage =
          q.answerFile
            ? fileToUrl(
                q.answerFile,
                "answer"
              )
            : "";

        const statusClass =
          q.status ===
          "cevaplandı"
            ? "done"
            : "waiting";

        html += `

<div class="card">

<div class="top-row">

<div>

<h2 class="question-id">
Soru ID: ${q.id}
</h2>

<p class="user">
Kullanıcı:
<strong>
${q.userId || "Eski soru"}
</strong>
</p>

</div>

<p
class="status ${statusClass}">
${q.status}
</p>

</div>

<p class="image-title">
Gönderilen soru
</p>

<img
class="question-image"
src="${questionImage}"
alt="Soru fotoğrafı">

<form
action="/panel-answer/${q.id}"
method="POST"
enctype="multipart/form-data">

<textarea
name="answer"
placeholder="Cevabı buraya yaz...">${q.answer || ""}</textarea>

<br><br>

<label>
<strong>
Çözüm fotoğrafı:
</strong>
</label>

<br>

<input
type="file"
name="answerFile"
accept="image/*">

<br>

<button
type="submit">
Cevabı Kaydet
</button>

</form>
`;

        if (
          q.answer
        ) {
          html += `

<div class="existing-answer">

<strong>
Mevcut yazılı cevap:
</strong>

<br><br>

${q.answer}

</div>
`;
        }

        if (
          answerImage
        ) {
          html += `

<p class="image-title">
Mevcut çözüm fotoğrafı
</p>

<img
class="answer-image"
src="${answerImage}"
alt="Çözüm fotoğrafı">
`;
        }

        html += `

</div>
`;
      }
    );

    html += `

</div>

</body>

</html>
`;

    res.send(html);
  }
);

// ----------------------------------------------------
// SERVER
// ----------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `SorBi server çalışıyor: ${PORT}`
    );
  }
);