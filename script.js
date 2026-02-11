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

  // 年度表示
  if (yearBadgeEl) {
    if (!word.year) {
      yearBadgeEl.textContent = "";
    } else if (word.year === "other") {
      yearBadgeEl.textContent = "その他";
    } else {
      yearBadgeEl.textContent = `${word.year} 年度`;
    }
  }

  // モード（英→日 / 日→英）
  const modeInput = document.querySelector('input[name="mode"]:checked');
  currentMode = modeInput ? modeInput.value : "en-ja";

  // ★ ここで発音する（英→日モードのときだけ）
  if (currentMode === "en-ja") {
    speak(word.en, "en-US");
  }

  // 出題形式（4択 / 記述）
  const qtypeInput = document.querySelector('input[name="qtype"]:checked');
  const qtype = qtypeInput ? qtypeInput.value : "choice";

  let questionText;
  let correctAnswers = [];
  let field;

  if (currentMode === "en-ja") {
    questionText = word.en;
    correctAnswers = [word.ja, word.jaSub].filter(Boolean);
    field = "ja";
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
  } else {
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