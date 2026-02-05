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
let currentStyle = "choice";        // "choice" or "input"

// ★ 単語ごとの成績を保存するための状態
let STATS = {};                     // { [id]: { seen, correct, wrong, lastAnsweredAt } }
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

// 「苦手・久しぶり」ほど優先度を上げるスコア
function priorityScore(word) {
  const s = STATS[word.id];
  // 一度も出題されていない単語は最優先
  if (!s || !s.seen) return 1000;

  const accuracy = s.correct / s.seen; // 0〜1（高いほど得意）
  const daysSince = (Date.now() - (s.lastAnsweredAt || 0)) / DAY_MS;

  // 正答率が低い + しばらく解いてないほどスコア↑
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

function normalizeRow(row, idx) {
  return {
    id: idx,
    en: row.en || "",
    // ja_main があれば優先。なければ旧 ja を fallback
    ja: row.ja_main || row.ja || "",
    jaSub: row.ja_sub || "",
    year: row.year || row.Year || "",
    kind: row.kind || "",
    inputOk: row.input_ok === "1" || row.input_ok === 1
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
  // 保存済みの成績をロード
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

  // 4択用ボタン
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

        // 間違えた問題を保存
        if (!wrongWords.includes(word)) {
          wrongWords.push(word);
        }
      }

      // 成績更新
      updateStats(word, isCorrect);

      if (wrongWords.length > 0) {
        retryWrongBtn.disabled = false;
      }

      nextBtn.disabled = false;
    });

    if (isCorrect) btn.dataset.correct = "1";
    return btn;
  }

  // 記述用の問題ビュー
  function normalizeAnswer(str) {
    return str
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

function isCorrectInput(userInput, answers) {
  const u = normalizeAnswer(userInput);
  if (!u) return false;

  // answers は ["本質的要素", "本質的な要素"] みたいな配列を想定
  return answers
    .map((s) => normalizeAnswer(s))
    .some((ans) => ans && ans === u);
}

function buildInputQuestion(correctAnswers, word) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.gap = "8px";
  wrapper.style.marginBottom = "8px";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "ここに入力";
  input.style.flex = "1";
  input.style.padding = "8px 10px";
  input.style.borderRadius = "12px";
  input.style.border = "1px solid rgba(255,255,255,0.12)";
  input.style.background = "rgba(8,13,26,0.95)";
  input.style.color = "#f5f7ff";

  const checkBtn = document.createElement("button");
  checkBtn.textContent = "答え合わせ";
  checkBtn.className = "secondary-btn answer-btn";
  checkBtn.style.flex = "0 0 auto";

  wrapper.appendChild(input);
  wrapper.appendChild(checkBtn);
  choicesEl.appendChild(wrapper);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      checkBtn.click();
    }
  });

  checkBtn.addEventListener("click", () => {
    if (hasAnswered) return;
    hasAnswered = true;

    const user = input.value;
    const ok = isCorrectInput(user, correctAnswers);

    const answerLabel = correctAnswers.join(" / ");

    if (ok) {
      correctCount++;
      feedbackEl.textContent = `⭕ 正解！ (${answerLabel})`;
    } else {
      feedbackEl.textContent = `❌ 不正解。正解: ${answerLabel}`;
      if (!wrongWords.includes(word)) {
        wrongWords.push(word);
      }
    }

    updateStats(word, ok);

    if (wrongWords.length > 0) {
      retryWrongBtn.disabled = false;
    }

    input.disabled = true;
    checkBtn.disabled = true;
    nextBtn.disabled = false;
  });

  setTimeout(() => input.focus(), 0);
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

  // モード
  const modeInput = document.querySelector('input[name="mode"]:checked');
  currentMode = modeInput ? modeInput.value : "en-ja";

  // 出題形式
  const styleInput = document.querySelector('input[name="qtype"]:checked');
  const qtype = styleInput ? styleInput.value : "choice"; // "choice" or "input"

  let questionText;
  let correctAnswers = []; // ★ 配列で持つ
  let field;

  if (currentMode === "en-ja") {
    questionText = word.en;
    // ja_main + ja_sub を両方候補にする（記述で使う）
    correctAnswers = [word.ja, word.jaSub].filter(Boolean);
    field = "ja";
  } else {
    questionText = word.ja;
    correctAnswers = [word.en]; // 英語側は基本1つでOK
    field = "en";
  }

  questionEl.textContent = questionText;

  if (qtype === "input") {
    // ★ 記述問題モード：複数候補すべて正解扱い
    buildInputQuestion(correctAnswers, word);
  } else {
    // ★ 4択モード：メインの意味だけを使う（最初の1個）
    const correctAnswer = correctAnswers[0];

    const others = shuffle(
      WORDS.filter((w) => w.id !== word.id && w[field])
    ).slice(0, 3);

    const options = shuffle(
      [correctAnswer].concat(others.map((w) => w[field]))
    );

    options.forEach((opt) => {
      const isCorrect = opt === correctAnswer;
      const btn = buildChoiceButton(opt, isCorrect, word);
      choicesEl.appendChild(btn);
    });
  }

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

    progressBarEl.style.width = "100%";
    showScreen("result");
  }

 function startNormalSession(settings) {
  let mode, year, count, qtype;

  currentSessionType = "normal";
  wrongWords = [];
  retryWrongBtn.disabled = true;

  if (!settings) {
    const modeInput = document.querySelector('input[name="mode"]:checked');
    mode = modeInput ? modeInput.value : "en-ja";

    const qtypeInput = document.querySelector('input[name="qtype"]:checked');
    qtype = qtypeInput ? qtypeInput.value : "choice"; // "choice" or "input"

    year = yearSelect ? yearSelect.value : "all";
    count = questionCountSelect ? questionCountSelect.value : "all";
    lastSettings = { mode, year, count, qtype };
  } else {
    ({ mode, year, count, qtype } = settings);
  }

  // 年度フィルタ
  let pool = WORDS.slice();
  if (yearSelect && year !== "all") {
    pool = pool.filter(w => (w.year || "") === year);
  }

  // ★ 記述モードのときだけ input_ok = true だけに絞る
  if (qtype === "input") {
    pool = pool.filter(w => w.inputOk);
  }

  if (!pool.length) {
    alert("その条件に合う単語がありません。年度や出題形式を変えてみてください。");
    return;
  }

  const num = count === "all"
    ? pool.length
    : Math.min(parseInt(count, 10), pool.length);

  // 苦手単語優先ロジックはそのまま使う
  pool.sort((a, b) => priorityScore(b) - priorityScore(a));
  const candidateCount = Math.min(pool.length, num * 2);
  const candidates = pool.slice(0, candidateCount);

  sessionWords = shuffle(candidates).slice(0, num);
  currentIndex = 0;
  correctCount = 0;

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
