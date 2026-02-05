// =======================================
//  Googleスプレッドシートの CSV URL
//  -------------------------------------
//  1. シートの1行目に「en,ja,year」と書く
//  2. ファイル → 共有 → ウェブに公開 → CSV を選ぶ
//  3. 出てきた URL を下の CSV_URL に貼る
// =======================================

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1eb5Qks5GwyyMM8UFOeKkPZ6U42UU6LoWN6jcNVGZzuk/export?format=csv&gid=0";

// =============================
//  グローバル状態
// =============================

let WORDS = [];              // 全単語
let sessionWords = [];       // 今回の出題リスト
let wrongWords = [];         // 間違えた単語リスト
let lastSettings = null;     // { mode, year, count }
let currentIndex = 0;
let correctCount = 0;
let hasAnswered = false;
let currentMode = "en-ja";          // "en-ja" or "ja-en"
let currentSessionType = "normal";  // "normal" or "wrong"

// ★ ここから【1】単語ごとの成績を保存するための状態
let STATS = {};                      // { [id]: { seen, correct, wrong, lastAnsweredAt } }
const DAY_MS = 1000 * 60 * 60 * 24;

// ---- 成績のロード／セーブ ----
function loadStats() {
  try {
    const raw = localStorage.getItem("wordStats");
    STATS = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn("stats の読み込みに失敗:", e);
    STATS = {};
  }
}

function saveStats() {
  try {
    localStorage.setItem("wordStats", JSON.stringify(STATS));
  } catch (e) {
    console.warn("stats の保存に失敗:", e);
  }
}

// 単語1件の成績を更新
function updateStats(word, isCorrect) {
  const id = word.id;
  if (!STATS[id]) {
    STATS[id] = { seen: 0, correct: 0, wrong: 0, lastAnsweredAt: null };
  }
  const s = STATS[id];
  s.seen++;
  if (isCorrect) s.correct++;
  else s.wrong++;
  s.lastAnsweredAt = Date.now();
  saveStats();
}

// ★ ここから【2】「苦手・久しぶり」ほど優先度を上げるスコア
function priorityScore(word) {
  const s = STATS[word.id];
  // 一度も出題されていない単語は最優先
  if (!s || !s.seen) return 1000;

  const accuracy = s.correct / s.seen; // 0〜1（高いほど得意）
  const daysSince = (Date.now() - (s.lastAnsweredAt || 0)) / DAY_MS;

  // 正答率が低い + しばらく解いてないほどスコア↑
  // （値は適当でOK、感覚的に効けば十分）
  return (1 - accuracy) * 10 + Math.min(daysSince, 10);
}

// =============================
//  CSV パーサー（超シンプル版）
//  ※カンマを含むテキストは想定しない
// =============================

function parseCSV(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] || "").trim();
    });
    rows.push(obj);
  }
  return rows;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// スプレッドシート1行分 → アプリ内部形式
function normalizeRow(row, idx) {
  return {
    id: idx,                         // 一意なID
    en: row.en || "",                // 英単語
    ja: row.ja || "",                // 日本語
    year: row.year || row.Year || "" // 年度（"2022" など）
  };
}

// =============================
//  単語データ読み込み
// =============================

async function loadWordsFromSheet() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error("HTTP error: " + res.status);
  const text = await res.text();
  console.log("スプレッドシートからCSV取得成功");
  return parseCSV(text);
}

// =============================
//  起動処理
// =============================

window.addEventListener("load", async () => {
  // ★ まず保存済みの成績をロード
  loadStats();

  // ---- DOM ----
  const screenHome = document.getElementById("screen-home");
  const screenQuiz = document.getElementById("screen-quiz");
  const screenResult = document.getElementById("screen-result");

  const startBtn = document.getElementById("start-btn");
  const nextBtn = document.getElementById("next-btn");
  const retryBtn = document.getElementById("retry-btn");
  const retryWrongBtn = document.getElementById("retry-wrong-btn");
  const backHomeBtn = document.getElementById("back-home-btn");

  const questionCountSelect = document.getElementById("question-count");
  const yearSelect = document.getElementById("year-filter");

  const statusEl = document.getElementById("status");
  const questionEl = document.getElementById("question-text");
  const choicesEl = document.getElementById("choices");
  const feedbackEl = document.getElementById("feedback");
  const progressBarEl = document.getElementById("progress-bar");

  const resultSummaryEl = document.getElementById("result-summary");
  const resultDetailEl = document.getElementById("result-detail");

  // ---- 単語ロード ----
  try {
    const rawRows = await loadWordsFromSheet();
    WORDS = rawRows
      .map(normalizeRow)
      .filter((w) => w.en && w.ja); // en / ja 両方入っているものだけ

    if (!WORDS.length) {
      alert("単語データが空です。スプレッドシートの内容を確認してください。");
      return;
    }

    console.log("読み込んだ単語数:", WORDS.length);
  } catch (e) {
    alert("単語データの読み込みに失敗しました。");
    console.error(e);
    return;
  }

  // =============================
  //  画面制御
  // =============================

  function showScreen(name) {
    screenHome.style.display = name === "home" ? "block" : "none";
    screenQuiz.style.display = name === "quiz" ? "block" : "none";
    screenResult.style.display = name === "result" ? "block" : "none";
  }

  function updateStatusAndProgress() {
    const total = sessionWords.length || 1;
    statusEl.textContent = `第 ${currentIndex + 1} 問 / 全 ${total} 問`;

    const rate = Math.min(currentIndex / total, 1);
    progressBarEl.style.width = `${rate * 100}%`;
  }

  // =============================
  //  クイズ処理
  // =============================

  function buildChoiceButton(text, isCorrect, word) {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = text;

    btn.addEventListener("click", () => {
      if (hasAnswered) return;
      hasAnswered = true;

      const buttons = choicesEl.querySelectorAll("button");
      buttons.forEach((b) => (b.disabled = true));

      if (isCorrect) {
        correctCount++;
        feedbackEl.textContent = "⭕ 正解！";
        btn.classList.add("correct");
      } else {
        feedbackEl.textContent = "❌ 不正解";
        btn.classList.add("wrong");

        // 正解のボタンをハイライト
        buttons.forEach((b) => {
          if (b.dataset.correct === "1") b.classList.add("correct");
        });

        // 間違えた問題を保存（同じオブジェクト参照がなければ追加）
        if (!wrongWords.includes(word)) {
          wrongWords.push(word);
        }
      }

      // ★ ここで成績を更新
      updateStats(word, isCorrect);

      // 間違えた問題が一つでもあればボタン有効化
      if (wrongWords.length > 0) {
        retryWrongBtn.disabled = false;
      }

      nextBtn.disabled = false;
    });

    if (isCorrect) btn.dataset.correct = "1";
    return btn;
  }

  function showQuestion() {
    if (currentIndex >= sessionWords.length) {
      endSession();
      return;
    }

    const word = sessionWords[currentIndex];
    hasAnswered = false;
    feedbackEl.textContent = "";
    choicesEl.innerHTML = "";
    nextBtn.disabled = true;

    const modeInput = document.querySelector('input[name="mode"]:checked');
    currentMode = modeInput ? modeInput.value : "en-ja";

    let questionText, correctAnswer, field;

    if (currentMode === "en-ja") {
      questionText = word.en;
      correctAnswer = word.ja;
      field = "ja";
    } else {
      questionText = word.ja;
      correctAnswer = word.en;
      field = "en";
    }

    questionEl.textContent = questionText;

    // 他の単語からダミー選択肢を作る
    const others = shuffle(
      WORDS.filter((w) => w.id !== word.id && w[field])
    ).slice(0, 3);

    const options = shuffle([correctAnswer].concat(others.map((w) => w[field])));

    options.forEach((opt) => {
      const isCorrect = opt === correctAnswer;
      const btn = buildChoiceButton(opt, isCorrect, word);
      choicesEl.appendChild(btn);
    });

    updateStatusAndProgress();
  }

  function endSession() {
    const total = sessionWords.length || 0;
    const percent =
      total === 0 ? 0 : ((correctCount / total) * 100).toFixed(1);

    resultSummaryEl.textContent =
      total === 0
        ? "出題された問題がありませんでした。"
        : `正解数 ${correctCount} / ${total}（${percent}%）`;

    if (total === 0) {
      resultDetailEl.textContent = "条件を変えてもう一度やってみよう。";
    } else if (percent === "100.0") {
      if (currentSessionType === "wrong") {
        resultDetailEl.textContent = "前に間違えた問題は全部解き直せたよ👍";
      } else {
        resultDetailEl.textContent = "全問正解！🎉 その調子！";
      }
    } else {
      resultDetailEl.textContent =
        "間違えた問題だけ復習したいときは「間違えた問題だけもう一度」を押してね。";
    }

    // 進捗バーを100%に
    progressBarEl.style.width = "100%";

    showScreen("result");
  }

  function startNormalSession(settings) {
    let mode, year, count;

    currentSessionType = "normal";
    wrongWords = []; // 新しい通常回ではリセット
    retryWrongBtn.disabled = true;

    if (!settings) {
      const modeInput = document.querySelector('input[name="mode"]:checked');
      mode = modeInput ? modeInput.value : "en-ja";
      year = yearSelect ? yearSelect.value : "all";
      count = questionCountSelect ? questionCountSelect.value : "all";
      lastSettings = { mode, year, count };
    } else {
      ({ mode, year, count } = settings);
    }

    // フィルタ（年度）
    let pool = WORDS.slice();
    if (yearSelect && year !== "all") {
      pool = pool.filter((w) => (w.year || "") === year);
    }

    if (!pool.length) {
      alert("その年度の単語がありません。年度の条件を変えてください。");
      return;
    }

    const num =
      count === "all" ? pool.length : Math.min(parseInt(count, 10), pool.length);

    // ★ 優先度スコアで並べ替え（苦手・久しぶりな単語が上に来る）
    pool.sort((a, b) => priorityScore(b) - priorityScore(a));

    // 上位から少しだけ広めに候補を取り、その中からランダムに num 件
    const candidateCount = Math.min(pool.length, num * 2);
    const candidates = pool.slice(0, candidateCount);

    sessionWords = shuffle(candidates).slice(0, num);
    currentIndex = 0;
    correctCount = 0;

    // 進捗バー初期化
    progressBarEl.style.width = "0%";

    showScreen("quiz");
    showQuestion();
  }

  function startWrongSession() {
    if (!wrongWords.length) {
      alert("まだ間違えた問題がありません。まずは普通に解いてみてください。");
      return;
    }

    currentSessionType = "wrong";

    sessionWords = shuffle(wrongWords.slice()); // コピーしてシャッフル
    currentIndex = 0;
    correctCount = 0;

    progressBarEl.style.width = "0%";

    showScreen("quiz");
    showQuestion();
  }

  // =============================
  //  イベント
  // =============================

  startBtn.onclick = () => startNormalSession(null);

  nextBtn.onclick = () => {
    currentIndex++;
    showQuestion();
  };

  retryBtn.onclick = () => {
    if (lastSettings) {
      startNormalSession(lastSettings);
    } else {
      startNormalSession(null);
    }
  };

  retryWrongBtn.onclick = () => {
    startWrongSession();
  };

  backHomeBtn.onclick = () => {
    showScreen("home");
  };

  // 初期画面
  showScreen("home");
});
