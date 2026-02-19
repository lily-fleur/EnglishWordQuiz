console.log("APP VERSION: 2026-02-17-01");

// =======================================
//  Googleスプレッドシートの CSV URL
// =======================================
const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1eb5Qks5GwyyMM8UFOeKkPZ6U42UU6LoWN6jcNVGZzuk/gviz/tq?tqx=out:csv&gid=0";
  
// =============================
//  グローバル状態
// =============================
let WORDS = [];              // 全単語
let sessionWords = [];       // 今回の出題リスト
let wrongWords = [];         // 間違えた単語リスト（次の「間違えた問題だけ」の種）
let wrongWordIds = new Set();// 間違えた単語ID（重複防止）

let lastSettings = null;     // { mode, year, count, qtype }
let currentIndex = 0;
let correctCount = 0;
let hasAnswered = false;

let currentMode = "en-ja";          // "en-ja" or "ja-en"
let currentSessionType = "normal";  // "normal" or "wrong"
let currentWord = null;             // 今出題している単語（発音ボタン用）
let currentQType = "choice";        // "choice" or "input"

// ★ 単語ごとの成績
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
  if (!s || !s.seen) return 1000; // 一度も出てないものは最優先

  const accuracy = s.correct / s.seen; // 0〜1
  const daysSince = (Date.now() - (s.lastAnsweredAt || 0)) / DAY_MS;
  return (1 - accuracy) * 10 + Math.min(daysSince, 10);
}

// =============================
//  CSV パーサー（簡易）
// =============================
// =============================
//  CSV パーサー
// =============================
function parseCSV(text) {
  // 行ごとに分割して、空行を除く
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ヘッダー + データが最低1行ずつないとダメ
  if (lines.length < 2) return [];

  const rows = [];

  // 0行目はヘッダーなので 1 行目からループ
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");

    // 列の「位置」で決め打ちする
    // A列:英語, B列:メイン日本語, C列:サブ日本語, D列:year, E列:kind, F列:input_ok
    const row = {
      en:       (cols[0] || "").trim(),
      ja_main:  (cols[1] || "").trim(),
      ja_sub:   (cols[2] || "").trim(),
      year:     (cols[3] || "").trim(),
      kind:     (cols[4] || "").trim(),
      input_ok: (cols[5] || "").trim(),
    };

    rows.push(row);
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
    ja: row.ja_main || row.ja || "",
    jaSub: row.ja_sub || "",
    year: row.year || row.Year || "",
    kind: row.kind || "",
    inputOk: row.input_ok === "1" || row.input_ok === 1,
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
//  音声読み上げ
// =============================
function speak(text, lang = "en-US") {
  if (!("speechSynthesis" in window)) return;

  const uttr = new SpeechSynthesisUtterance(text);
  uttr.lang = lang;
  uttr.rate = 0.9;
  uttr.pitch = 1.0;

  speechSynthesis.cancel();
  speechSynthesis.speak(uttr);
}

// =============================
//  起動処理
// =============================
window.addEventListener("load", async () => {
  loadStats();

  // ---- DOM ----
  const screenHome   = document.getElementById("screen-home");
  const screenQuiz   = document.getElementById("screen-quiz");
  const screenResult = document.getElementById("screen-result");

  const startBtn      = document.getElementById("start-btn");
  const nextBtn       = document.getElementById("next-btn");
  const retryBtn      = document.getElementById("retry-btn");
  const retryWrongBtn = document.getElementById("retry-wrong-btn");
  const backHomeBtn   = document.getElementById("back-home-btn");

  const questionCountSelect = document.getElementById("question-count");
  const yearSelect          = document.getElementById("year-filter");

  const statusEl      = document.getElementById("status");
  const questionEl    = document.getElementById("question-text");
  const choicesEl     = document.getElementById("choices");
  const feedbackEl    = document.getElementById("feedback");
  const progressBarEl = document.getElementById("progress-bar");

  const resultSummaryEl = document.getElementById("result-summary");
  const resultDetailEl  = document.getElementById("result-detail");

  const yearBadgeEl = document.getElementById("year-badge");
  const speakBtn    = document.getElementById("speak-btn");

  // ---- 重要：DOMが取れてないときは即止めて原因を出す ----
  const missing = [];
  if (!screenHome) missing.push("screen-home");
  if (!screenQuiz) missing.push("screen-quiz");
  if (!screenResult) missing.push("screen-result");
  if (!startBtn) missing.push("start-btn");
  if (!nextBtn) missing.push("next-btn");
  if (!retryBtn) missing.push("retry-btn");
  if (!retryWrongBtn) missing.push("retry-wrong-btn");
  if (!backHomeBtn) missing.push("back-home-btn");
  if (!questionEl) missing.push("question-text");
  if (!choicesEl) missing.push("choices");
  if (!feedbackEl) missing.push("feedback");
  if (!progressBarEl) missing.push("progress-bar");
  if (!statusEl) missing.push("status");
  if (!resultSummaryEl) missing.push("result-summary");
  if (!resultDetailEl) missing.push("result-detail");
  if (missing.length) {
    console.error("DOMが見つからない:", missing);
    alert("HTMLのidが合ってない: " + missing.join(", "));
    return;
  }

  // ---- 単語ロード ----
  try {
    const rawRows = await loadWordsFromSheet();
    WORDS = rawRows.map(normalizeRow).filter((w) => w.en && w.ja);

    if (!WORDS.length) {
      alert("単語データが空です。スプレッドシートの内容を確認してください。");
      return;
    }

    console.log("読み込んだ単語数:", WORDS.length);
  } catch (e) {
    alert("単語データの読み込みに失敗しました。スプレッドシート公開設定/URLを確認してください。");
    console.error(e);
    return;
  }

  // =============================
  //  画面制御
  // =============================
  function showScreen(name) {
    screenHome.style.display   = name === "home"   ? "block" : "none";
    screenQuiz.style.display   = name === "quiz"   ? "block" : "none";
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

  // ★ 間違い登録（重複防止）
  function recordWrong(word) {
    if (!wrongWordIds.has(word.id)) {
      wrongWordIds.add(word.id);
      wrongWords.push(word);
    }
  }

  // ---- 4択ボタン ----
  function buildChoiceButton(labelText, isCorrect, word) {
    const btn = document.createElement("button");
    btn.className = "choice-btn";

    // 表示を「番号」と「本文」に分割（例: "① 〜〜"）
    const numberSpan = document.createElement("span");
    numberSpan.className = "choice-number";

    const textSpan = document.createElement("span");
    textSpan.className = "choice-text";

    const firstSpace = labelText.indexOf(" ");
    const num = firstSpace === -1 ? "" : labelText.slice(0, firstSpace);
    const body = firstSpace === -1 ? labelText : labelText.slice(firstSpace + 1);

    numberSpan.textContent = num;
    textSpan.textContent = body;

    btn.appendChild(numberSpan);
    btn.appendChild(textSpan);

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

        buttons.forEach((b) => {
          if (b.dataset.correct === "1") b.classList.add("correct");
        });

        recordWrong(word);
      }

      updateStats(word, isCorrect);

      if (wrongWords.length > 0) retryWrongBtn.disabled = false;
      nextBtn.disabled = false;
    });

    if (isCorrect) btn.dataset.correct = "1";
    return btn;
  }

  // ---- 記述系 ----
  function normalizeAnswer(str) {
    return str.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isCorrectInput(userInput, answers) {
    const u = normalizeAnswer(userInput);
    if (!u) return false;
    return answers.map(normalizeAnswer).some((ans) => ans && ans === u);
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

    // Enterキー制御（記述はここ）
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!hasAnswered) checkBtn.click();
      else nextBtn.click();
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
        recordWrong(word);
      }

      updateStats(word, ok);

      if (wrongWords.length > 0) retryWrongBtn.disabled = false;

      input.readOnly = true;
      checkBtn.disabled = true;
      nextBtn.disabled = false;
    });

    setTimeout(() => input.focus(), 0);
  }

  // ---- 1問出す ----
  function showQuestion() {
    if (currentIndex >= sessionWords.length) {
      endSession();
      return;
    }

    const word = sessionWords[currentIndex];
    currentWord = word;

    hasAnswered = false;
    feedbackEl.textContent = "";
    choicesEl.innerHTML = "";
    nextBtn.disabled = true;

    // 年度表示
    if (yearBadgeEl) {
      if (!word.year) yearBadgeEl.textContent = "";
      else if (word.year === "other") yearBadgeEl.textContent = "その他";
      else yearBadgeEl.textContent = `${word.year} 年度`;
    }

    // モード
    const modeInput = document.querySelector('input[name="mode"]:checked');
    currentMode = modeInput ? modeInput.value : "en-ja";

    // 出題形式
    const qtypeInput = document.querySelector('input[name="qtype"]:checked');
    const qtype = qtypeInput ? qtypeInput.value : "choice";
    currentQType = qtype;

    let questionText;
    let correctAnswers = [];
    let field;

    if (currentMode === "en-ja") {
      questionText = word.en;
      correctAnswers = [word.ja, word.jaSub].filter(Boolean);
      field = "ja";
      speak(word.en, "en-US");
    } else {
      questionText = word.ja;
      correctAnswers = [word.en];
      field = "en";
    }

    if (!correctAnswers.length) {
      correctAnswers = [currentMode === "en-ja" ? word.ja : word.en].filter(Boolean);
    }

    questionEl.textContent = questionText;

    if (qtype === "input") {
      buildInputQuestion(correctAnswers, word);
      updateStatusAndProgress();
      return;
    }

    // 4択
    const correctAnswer = correctAnswers[0];
    const others = shuffle(
      WORDS.filter((w) => w.id !== word.id && w[field])
    ).slice(0, 3);

    const options = shuffle(
      [correctAnswer].concat(others.map((w) => w[field]))
    );

    const numLabels = ["①", "②", "③", "④"];

    options.forEach((opt, i) => {
      const isCorrect = opt === correctAnswer;
      const label = `${numLabels[i]} ${opt}`;
      const btn = buildChoiceButton(label, isCorrect, word);
      choicesEl.appendChild(btn);
    });

    updateStatusAndProgress();
  }

  // ---- 終了 ----
  function endSession() {
    const total = sessionWords.length || 0;
    const percent = total === 0 ? 0 : ((correctCount / total) * 100).toFixed(1);

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
        resultDetailEl.textContent = "全問正解！🎉";
      }
    } else {
      resultDetailEl.textContent =
        "間違えた問題だけ復習したいときは「間違えた問題だけもう一度」を押してね。";
    }

    progressBarEl.style.width = "100%";
    showScreen("result");
  }

  // ---- 通常セッション開始 ----
  function startNormalSession(settings) {
    let mode, year, count, qtype;

    currentSessionType = "normal";

    // 通常開始時：間違いをリセット
    wrongWords = [];
    wrongWordIds = new Set();
    retryWrongBtn.disabled = true;

    if (!settings) {
      const modeInput = document.querySelector('input[name="mode"]:checked');
      mode = modeInput ? modeInput.value : "en-ja";

      const qtypeInput = document.querySelector('input[name="qtype"]:checked');
      qtype = qtypeInput ? qtypeInput.value : "choice";

      year = yearSelect ? yearSelect.value : "all";
      count = questionCountSelect ? questionCountSelect.value : "all";
      lastSettings = { mode, year, count, qtype };
    } else {
      ({ mode, year, count, qtype } = settings);
    }

    // 年度フィルタ
    let pool = WORDS.slice();
    if (yearSelect && year !== "all") {
      pool = pool.filter((w) => (w.year || "") === year);
    }

    // 記述モードのときだけ input_ok = 1
    if (qtype === "input") {
      pool = pool.filter((w) => w.inputOk);
    }

    if (!pool.length) {
      alert("その条件に合う単語がありません。年度や出題形式を変えてみてください。");
      return;
    }

    const num =
      count === "all"
        ? pool.length
        : Math.min(parseInt(count, 10), pool.length);

    // 苦手単語優先
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

  // ---- 間違えた問題だけ（直近の間違いだけにする） ----
  function startWrongSession() {
    if (!wrongWords.length) {
      alert("まだ間違えた問題がありません。まずは普通に解いてみてください。");
      return;
    }

    currentSessionType = "wrong";

    // ★ 直近の間違いだけを出題対象として退避
    const latestWrong = wrongWords.slice();

    // ★ 次の復習が「今回の復習で間違えた分だけ」になるようにリセット
    wrongWords = [];
    wrongWordIds = new Set();

    sessionWords = shuffle(latestWrong);
    currentIndex = 0;
    correctCount = 0;

    progressBarEl.style.width = "0%";
    showScreen("quiz");
    showQuestion();
  }

  // =============================
  //  キーボード操作（4択: 1〜4 / 回答後Enterで次へ）
  // =============================
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (screenQuiz.style.display !== "block") return;
    if (e.isComposing) return;

    // 回答後Enterで次へ（4択/記述どっちでも）
    if (e.key === "Enter" && hasAnswered && !nextBtn.disabled) {
      e.preventDefault();
      nextBtn.click();
      return;
    }

    // 4択の回答前だけ 1〜4
    if (currentQType !== "choice") return;
    if (hasAnswered) return;

    const k = e.key;
    if (k >= "1" && k <= "4") {
      e.preventDefault();
      const idx = Number(k) - 1;
      const buttons = choicesEl.querySelectorAll("button.choice-btn");
      const target = buttons[idx];
      if (target && !target.disabled) target.click();
    }
  });

  // =============================
  //  イベント
  // =============================
  startBtn.onclick = () => startNormalSession(null);

  nextBtn.onclick = () => {
    currentIndex++;
    showQuestion();
  };

  retryBtn.onclick = () => {
    startNormalSession(lastSettings || null);
  };

  retryWrongBtn.onclick = () => {
    startWrongSession();
  };

  backHomeBtn.onclick = () => {
    showScreen("home");
  };

  // 🔊 ボタン：今の単語の英語を読む
  if (speakBtn) {
    speakBtn.onclick = () => {
      if (!currentWord) return;
      speak(currentWord.en, "en-US");
    };
  }

  // 初期画面
  showScreen("home");
});