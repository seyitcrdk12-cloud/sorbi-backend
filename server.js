const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const FREE_QUESTION_LIMIT = 3;
const PACKAGE_QUESTION_COUNT = 15;

const uploadsDir = path.join(__dirname, "uploads");
const answersDir = path.join(__dirname, "answers");
const questionsFile = path.join(__dirname, "questions.json");
const usersFile = path.join(__dirname, "users.json");

// ----------------------------------------------------
// DOSYA VE KLASÖRLER
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

if (!fs.existsSync(usersFile)) {
  fs.writeFileSync(
    usersFile,
    JSON.stringify({}, null, 2),
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
// QUESTIONS
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

// ----------------------------------------------------
// USERS / PAKET HAKLARI
// ----------------------------------------------------

function readUsers() {
  try {
    const data = fs.readFileSync(
      usersFile,
      "utf8"
    );

    if (!data.trim()) {
      return {};
    }

    return JSON.parse(data);
  } catch (error) {
    console.error(
      "users.json okuma hatası:",
      error
    );

    return {};
  }
}

function writeUsers(users) {
  fs.writeFileSync(
    usersFile,
    JSON.stringify(
      users,
      null,
      2
    ),
    "utf8"
  );
}

function getPaidCredits(userId) {
  const users = readUsers();

  if (!users[userId]) {
    return 0;
  }

  return Number(
    users[userId].paidCredits || 0
  );
}

function addPaidCredits(
  userId,
  amount
) {
  const users = readUsers();

  if (!users[userId]) {
    users[userId] = {
      paidCredits: 0,
    };
  }

  users[userId].paidCredits =
    Number(
      users[userId].paidCredits || 0
    ) + amount;

  users[userId].updatedAt =
    new Date().toISOString();

  writeUsers(users);

  return users[userId].paidCredits;
}

function usePaidCredit(userId) {
  const users = readUsers();

  if (
    !users[userId] ||
    Number(
      users[userId].paidCredits || 0
    ) <= 0
  ) {
    return false;
  }

  users[userId].paidCredits =
    Number(
      users[userId].paidCredits
    ) - 1;

  users[userId].updatedAt =
    new Date().toISOString();

  writeUsers(users);

  return true;
}

// ----------------------------------------------------
// YARDIMCI FONKSİYONLAR
// ----------------------------------------------------

function cleanUploadPath(filePath) {
  if (!filePath) {
    return "";
  }

  const normalized =
    filePath.replace(/\\/g, "/");

  const uploadsIndex =
    normalized.lastIndexOf("/uploads/");

  if (uploadsIndex !== -1) {
    return normalized.substring(
      uploadsIndex + 1
    );
  }

  if (
    normalized.startsWith("uploads/")
  ) {
    return normalized;
  }

  return `uploads/${path.basename(normalized)}`;
}

function cleanAnswerPath(filePath) {
  if (!filePath) {
    return "";
  }

  const normalized =
    filePath.replace(/\\/g, "/");

  const answersIndex =
    normalized.lastIndexOf("/answers/");

  if (answersIndex !== -1) {
    return normalized.substring(
      answersIndex + 1
    );
  }

  if (
    normalized.startsWith("answers/")
  ) {
    return normalized;
  }

  return `answers/${path.basename(normalized)}`;
}

function fileToUrl(
  filePath,
  type
) {
  if (!filePath) {
    return "";
  }

  const cleanPath =
    type === "answer"
      ? cleanAnswerPath(filePath)
      : cleanUploadPath(filePath);

  return `/${cleanPath}`;
}

function getUserQuestions(
  questions,
  userId
) {
  return questions.filter(
    (q) => q.userId === userId
  );
}

function getFreeUsed(
  questions,
  userId
) {
  const userQuestions =
    getUserQuestions(
      questions,
      userId
    );

  return Math.min(
    userQuestions.length,
    FREE_QUESTION_LIMIT
  );
}

function getFreeRemaining(
  questions,
  userId
) {
  const used =
    getFreeUsed(
      questions,
      userId
    );

  const remaining =
    FREE_QUESTION_LIMIT - used;

  return remaining > 0
    ? remaining
    : 0;
}

function getRightsInfo(
  questions,
  userId
) {
  const freeRemaining =
    getFreeRemaining(
      questions,
      userId
    );

  const paidRemaining =
    getPaidCredits(userId);

  return {
    freeQuestionLimit:
      FREE_QUESTION_LIMIT,

    freeRemaining:
      freeRemaining,

    paidRemaining:
      paidRemaining,

    totalRemaining:
      freeRemaining +
      paidRemaining,

    needsPackage:
      freeRemaining <= 0 &&
      paidRemaining <= 0,
  };
}

// ----------------------------------------------------
// ANA SAYFA
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.send(
    "SorBi server çalışıyor"
  );
});

// ----------------------------------------------------
// KULLANICI HAKLARI
// ----------------------------------------------------

app.get(
  "/rights/:userId",
  (req, res) => {
    try {
      const userId =
        req.params.userId;

      const questions =
        readQuestions();

      return res.json(
        getRightsInfo(
          questions,
          userId
        )
      );
    } catch (error) {
      console.error(
        "Hak bilgisi hatası:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Hak bilgisi alınamadı.",
        });
    }
  }
);

// ----------------------------------------------------
// TEST İÇİN 15 SORU HAKKI EKLE
// ----------------------------------------------------

app.post(
  "/admin/add-package/:userId",
  (req, res) => {
    try {
      const userId =
        req.params.userId;

      const newBalance =
        addPaidCredits(
          userId,
          PACKAGE_QUESTION_COUNT
        );

      console.log(
        "Paket eklendi:",
        userId,
        "Yeni bakiye:",
        newBalance
      );

      return res.redirect(
        "/panel"
      );
    } catch (error) {
      console.error(
        "Paket ekleme hatası:",
        error
      );

      return res
        .status(500)
        .send(
          "Paket eklenemedi"
        );
    }
  }
);

// ----------------------------------------------------
// YENİ SORU
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
        req.body.userId
          ?.toString();

      if (!userId) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch (_) {}

        return res
          .status(400)
          .json({
            error:
              "Kullanıcı ID bulunamadı.",
          });
      }

      const questions =
        readQuestions();

      const freeRemaining =
        getFreeRemaining(
          questions,
          userId
        );

      const paidRemaining =
        getPaidCredits(
          userId
        );

      let creditType = "";

      // Önce ücretsiz hak kullanılır.
      if (freeRemaining > 0) {
        creditType = "free";
      } else if (
        paidRemaining > 0
      ) {
        const used =
          usePaidCredit(
            userId
          );

        if (!used) {
          try {
            fs.unlinkSync(
              req.file.path
            );
          } catch (_) {}

          return res
            .status(403)
            .json({
              error:
                "Soru hakkın bulunmuyor.",
              code:
                "NO_CREDITS",
            });
        }

        creditType = "paid";
      } else {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch (_) {}

        return res
          .status(403)
          .json({
            error:
              "Ücretsiz soru hakkın bitti. Yeni paket satın almalısın.",

            code:
              "PACKAGE_REQUIRED",

            freeRemaining:
              0,

            paidRemaining:
              0,

            totalRemaining:
              0,
          });
      }

      const newQuestion = {
        id:
          Date.now(),

        userId:
          userId,

        file:
          cleanUploadPath(
            req.file.path
          ),

        creditType:
          creditType,

        status:
          "bekliyor",

        answer:
          "",

        answerFile:
          "",

        createdAt:
          new Date().toISOString(),

        answeredAt:
          null,
      };

      questions.push(
        newQuestion
      );

      writeQuestions(
        questions
      );

      const rights =
        getRightsInfo(
          questions,
          userId
        );

      console.log(
        "Yeni soru:",
        newQuestion.id,
        "Kullanıcı:",
        userId,
        "Hak tipi:",
        creditType,
        "Kalan toplam:",
        rights.totalRemaining
      );

      return res.json({
        result:
          "Sorun hocana ulaştı.",

        id:
          newQuestion.id,

        creditType:
          creditType,

        ...rights,
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
// KULLANICININ SORULARI
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
// HOCA CEVABI
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
content="width=device-width, initial-scale=1.0"
>

<title>
SorBi Hoca Paneli
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  font-family: Arial, sans-serif;
  background: #f5f4fa;
  margin: 0;
  padding: 25px;
}

.container {
  max-width: 950px;
  margin: 0 auto;
}

h1 {
  color: #6547d8;
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
  justify-content:
  space-between;
  gap: 15px;
  flex-wrap: wrap;
}

.user {
  color: #555;
}

.rights {
  background: #eeeafe;
  padding: 12px;
  border-radius: 10px;
  margin-top: 10px;
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

.question-image,
.answer-image {
  display: block;
  max-width: 500px;
  width: 100%;
  max-height: 600px;
  object-fit: contain;
  border-radius: 12px;
  margin-top: 12px;
  border: 1px solid #eee;
}

textarea {
  width: 100%;
  min-height: 110px;
  margin-top: 15px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid #ccc;
  font-size: 16px;
}

button {
  margin-top: 15px;
  padding: 12px 20px;
  background: #7057e8;
  color: white;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}

.package-button {
  background: #19172a;
}

.existing-answer {
  background: #f2efff;
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

        const userId =
          q.userId || "";

        const paidCredits =
          userId
            ? getPaidCredits(
                userId
              )
            : 0;

        html += `

<div class="card">

<div class="top-row">

<div>

<h2>
Soru ID:
${q.id}
</h2>

<p class="user">
Kullanıcı:
<strong>
${userId || "Eski soru"}
</strong>
</p>

`;

        if (userId) {
          html += `

<div class="rights">

<strong>
Paket soru hakkı:
${paidCredits}
</strong>

<form
action="/admin/add-package/${userId}"
method="POST"
>

<button
class="package-button"
type="submit"
>
+15 Soru Hakkı Ver
</button>

</form>

</div>
`;
        }

        html += `

</div>

<p class="status ${statusClass}">
${q.status}
</p>

</div>

<p>
<strong>
Gönderilen soru
</strong>
</p>

<img
class="question-image"
src="${questionImage}"
alt="Soru fotoğrafı"
>

<form
action="/panel-answer/${q.id}"
method="POST"
enctype="multipart/form-data"
>

<textarea
name="answer"
placeholder="Cevabı buraya yaz..."
>${q.answer || ""}</textarea>

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
accept="image/*"
>

<br>

<button
type="submit"
>
Cevabı Kaydet
</button>

</form>
`;

        if (q.answer) {
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

        if (answerImage) {
          html += `

<p>
<strong>
Mevcut çözüm fotoğrafı
</strong>
</p>

<img
class="answer-image"
src="${answerImage}"
alt="Çözüm fotoğrafı"
>
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