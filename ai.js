require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('⚠️ WARNING: GEMINI_API_KEY is not defined in environment variables or .env');
}

const genAI = new GoogleGenerativeAI(apiKey || '');

// Primary model per specification, with resilient multi-tier fallback for 404/429
const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-1.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-latest'
].filter(Boolean);

let preferredModelIndex = 0;

/**
 * Helper to execute Gemini generation with robust multi-model fallback
 */
async function executeWithModel(callFn, config = {}) {
  let lastError = null;

  for (let i = preferredModelIndex; i < CANDIDATE_MODELS.length; i++) {
    const modelName = CANDIDATE_MODELS[i];
    try {
      const model = genAI.getGenerativeModel({ model: modelName, ...config });
      const result = await callFn(model);
      preferredModelIndex = i; // Cache working model
      return result;
    } catch (err) {
      lastError = err;
      const isRecoverable =
        err.status === 404 ||
        err.status === 429 ||
        err.status === 503 ||
        (err.message && (err.message.includes('404') || err.message.includes('429') || err.message.includes('Quota') || err.message.includes('503')));
      if (isRecoverable && i < CANDIDATE_MODELS.length - 1) {
        console.warn(`[AI Service] Model ${modelName} returned status ${err.status || 'error'}, falling back to ${CANDIDATE_MODELS[i + 1]}`);
        continue;
      }
      throw err;
    }
  }

  // If we started with a cached preferred index that failed, reset to 0 and try full list
  if (preferredModelIndex > 0) {
    preferredModelIndex = 0;
    return executeWithModel(callFn, config);
  }

  throw lastError;
}

function cleanJSONResponse(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

function sanitizeJsonStringLiterals(jsonStr) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

function safeJSONParse(rawText) {
  const cleaned = cleanJSONResponse(rawText);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const noControls = sanitizeJsonStringLiterals(cleaned);
    try {
      return JSON.parse(noControls);
    } catch (e1) {
      // Attempt 1: Fix unescaped backslashes that are not valid standard JSON escape sequences
      try {
        const fixed = noControls.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
        return JSON.parse(fixed);
      } catch (e2) {
        // Attempt 2: Handle LaTeX commands (like \frac, \beta, \Delta, \ge, \text) where single backslashes occur
        try {
          const fixed2 = noControls.replace(/\\([a-zA-Z0-9_{}^+\-*\/()[\],.;:><=!|@#%&~`])/g, (match, ch) => {
            if (ch === 'n' || ch === 'r' || ch === 't') return match;
            return '\\\\' + ch;
          });
          return JSON.parse(fixed2);
        } catch (e3) {
          throw err;
        }
      }
    }
  }
}

/**
 * Universal Unicode and Emoji Unescaper
 * Decodes \U0001f3af (Python/C 8-digit), \u{1f3af} (ES6), and \u2705 (standard 4-digit) into actual emojis.
 */
function decodeUnicodeEscapes(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\\U([0-9a-fA-F]{8})/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/\\u\{([0-9a-fA-F]+)\}/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/\\u([0-9a-fA-F]{4})/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

// Helper: Determine if text is asking for quiz practice (used as fallback in orchestrator)
function isQuizIntent(text) {
  const lower = String(text || '').toLowerCase().trim();
  return (
    lower.includes('quiz') ||
    lower.includes('test me') ||
    lower.includes('test on') ||
    lower.includes('give me a quiz') ||
    lower.includes('mcq') ||
    lower.includes('questions') ||
    lower.includes('practice')
  );
}

// Helper: Contextual topic extraction (used as fallback in orchestrator)
function extractTopicWithContext(text, history = []) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^(give me a quiz on|take a quiz on this|take a quiz on that|take a quiz on|quiz on that|quiz on this|quiz on|quiz|test me on this|test me on that|test me on|test on|test|explain more about this|explain more about that|explain more about|explain that|explain this|explain|teach me about|teach me|what is|how does|what are)/i, '').trim();
  clean = clean.replace(/[?.!]+$/g, '').trim();

  const isReferential = !clean || /^(that|this|it|this topic|that topic|the topic|same|the same|same topic)$/i.test(clean);

  if (isReferential && Array.isArray(history) && history.length > 0) {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg) continue;
      if (msg.topic && typeof msg.topic === 'string' && msg.topic.trim()) {
        return msg.topic.trim();
      }
      const t = String(msg.text || '');
      const quizMatch = t.match(/quiz on (.+?) at/i);
      if (quizMatch && quizMatch[1]) return quizMatch[1].trim();

      const gapMatch = t.match(/on (.+?)\. Lesson:/i);
      if (gapMatch && gapMatch[1]) return gapMatch[1].trim();

      if (msg.role === 'user') {
        let prevClean = t.replace(/^(give me a quiz on|take a quiz on this|take a quiz on that|take a quiz on|quiz on|quiz|test me on|test on|test|explain more about|explain|teach me about|teach me|what is|how does|what are)/i, '').trim();
        prevClean = prevClean.replace(/[?.!]+$/g, '').trim();
        if (prevClean && !/^(that|this|it|this topic|that topic|the topic|same|the same|same topic)$/i.test(prevClean)) {
          return prevClean;
        }
      }
    }
  }

  return clean || 'General Science';
}

/**
 * 1. analyzeAndStrategize(userMessage, chatHistory, userProfile)
 * The Dynamic AI Orchestrator Master Brain.
 * Prompts Gemini to return a pedagogical strategy JSON without hardcoded routing or lengths:
 * {
 *   intent: "TEACH" | "QUIZ" | "CLARIFY_DOUBT",
 *   derived_topic: "The exact core academic topic",
 *   optimal_quiz_length: <number between 3 and 15, based on topic complexity>,
 *   difficulty: "adaptive difficulty level",
 *   reasoning: "Internal thought process"
 * }
 */
async function analyzeAndStrategize(userMessage, chatHistory = [], userProfile = {}) {
  try {
    const academicLevel = userProfile.academic_level || 'College';
    const gapsList = Array.isArray(userProfile.knowledge_gaps) && userProfile.knowledge_gaps.length > 0
      ? userProfile.knowledge_gaps.map((g) => (typeof g === 'string' ? g : g.concept || '')).filter(Boolean).join(', ')
      : 'None identified yet';

    let historyText = 'None (New Conversation - No Prior Context)';
    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
      historyText = chatHistory.slice(-8).map((m) => {
        const role = m.role === 'user' ? 'Student' : 'Tutor';
        const topicTag = m.topic ? ` [Topic: ${m.topic}]` : '';
        return `${role}${topicTag}: ${m.text}`;
      }).join('\n');
    }

    const prompt = `You are the master AI Pedagogical Orchestrator and Learning Brain for an adaptive EdTech platform.
Your job is to analyze the student's message, their academic profile, known knowledge gaps, and prior conversation history to devise the optimal learning strategy.

STUDENT PROFILE:
- Academic Level: "${academicLevel}"
- Mastery Score: ${userProfile.score || 0}
- Prior Knowledge Gaps: "${gapsList}"

CONVERSATION HISTORY:
${historyText}

LATEST STUDENT MESSAGE:
"${userMessage}"

STRICT TOPIC ISOLATION RULES:
1. If the student names or switches to a new academic topic (e.g. "Photoelectric Effect", "Calculus", "Photosynthesis"), focus EXCLUSIVELY on that new topic.
2. DO NOT mix, blend, or compare prior subjects from the conversation history into the derived topic unless the student explicitly asks to compare them.
3. Only use conversation history to resolve referential pronouns ("that", "this", "it", "the same topic", "take a quiz on this").
4. If CONVERSATION HISTORY is "None (New Conversation - No Prior Context)", treat this turn as completely fresh without ANY previous topic assumptions or baggage.

ANALYZE AND STRATEGIZE:
1. "intent": Determine the primary educational intent. MUST be strictly one of:
   - "QUIZ": Student wants to test their knowledge, practice, take a quiz/assessment, or requested questions.
   - "CLARIFY_DOUBT": Student is asking a specific doubt, why a prior answer was wrong, clarification on a formula, or confused about a concept.
   - "TEACH": Student wants to learn a new topic, needs an explanation, requested teaching, or asked general conceptual questions.
2. "derived_topic": Extract the exact core academic topic (completely isolated from previous topics).
3. "optimal_quiz_length": Determine the optimal number of questions strictly between 3 and 15 based on topic complexity.
   - For quick checks or narrow micro-concepts: 3 to 5 questions.
   - For standard multi-faceted topics: 6 to 9 questions.
   - For broad, complex, or university-level topics: 10 to 15 questions.
4. "difficulty": Tailor the difficulty to their academic level ("${academicLevel}") and mastery.
5. "reasoning": A clear 1-sentence pedagogical rationale explaining why this intent, topic, quiz length, and difficulty were chosen.

CRITICAL FOR JSON: In string values, escape any backslashes as double backslashes ("\\\\") so the JSON parses cleanly.

Return strictly valid JSON with this exact schema:
{
  "intent": "TEACH" | "QUIZ" | "CLARIFY_DOUBT",
  "derived_topic": "The exact core academic topic",
  "optimal_quiz_length": 5,
  "difficulty": "adaptive difficulty level",
  "reasoning": "Internal pedagogical rationale"
}`;

    const result = await executeWithModel(
      (model) => model.generateContent(prompt),
      { generationConfig: { responseMimeType: 'application/json' } }
    );

    const parsed = safeJSONParse(result.response.text());

    // Normalize intent
    let intent = String(parsed.intent || 'TEACH').toUpperCase().trim();
    if (!['TEACH', 'QUIZ', 'CLARIFY_DOUBT'].includes(intent)) {
      if (intent.includes('QUIZ') || intent.includes('TEST')) intent = 'QUIZ';
      else if (intent.includes('DOUBT') || intent.includes('CLARIF') || intent.includes('WHY')) intent = 'CLARIFY_DOUBT';
      else intent = 'TEACH';
    }

    // Normalize derived_topic with unicode decoding
    let derivedTopic = decodeUnicodeEscapes(String(parsed.derived_topic || '').trim());
    if (!derivedTopic || /^(that|this|it|same|the same)$/i.test(derivedTopic)) {
      derivedTopic = extractTopicWithContext(userMessage, chatHistory);
    }

    // Normalize optimal_quiz_length (strictly between 3 and 15)
    let length = parseInt(parsed.optimal_quiz_length, 10);
    if (isNaN(length) || length < 3) length = 5;
    if (length > 15) length = 15;

    // Normalize difficulty
    let difficulty = decodeUnicodeEscapes(String(parsed.difficulty || academicLevel || 'College').trim());

    // Reasoning
    let reasoning = decodeUnicodeEscapes(String(parsed.reasoning || `Orchestrated ${intent} for ${derivedTopic} at ${difficulty} level.`));

    return {
      intent,
      derived_topic: derivedTopic,
      optimal_quiz_length: length,
      difficulty,
      reasoning
    };
  } catch (error) {
    console.error('Error in analyzeAndStrategize:', error);
    const isQuiz = isQuizIntent(userMessage);
    const derivedTopic = extractTopicWithContext(userMessage, chatHistory);
    const academicLevel = userProfile.academic_level || 'College';
    return {
      intent: isQuiz ? 'QUIZ' : 'TEACH',
      derived_topic: derivedTopic,
      optimal_quiz_length: 5,
      difficulty: academicLevel,
      reasoning: `Orchestrator fallback: Detected ${isQuiz ? 'quiz practice' : 'teaching'} intent on ${derivedTopic}.`
    };
  }
}

/**
 * 2. generateAdaptiveQuiz(topic, knownGaps, academicLevel, count, conversationHistory, orchestratorReasoning)
 * Generates MCQs dynamically calibrated to student's academic level, prior gaps, and exact optimal count.
 * Never hardcodes question count!
 */
async function generateAdaptiveQuiz(
  topic,
  knownGaps = [],
  academicLevel = 'College',
  count = 5,
  conversationHistory = [],
  orchestratorReasoning = ''
) {
  const targetCount = Math.max(3, Math.min(15, parseInt(count, 10) || 5));
  try {
    const levelStr = String(academicLevel || 'College / Undergraduate').trim();
    const gapsList = Array.isArray(knownGaps) && knownGaps.length > 0
      ? knownGaps.map((g) => (typeof g === 'string' ? g : g.concept || '')).filter(Boolean).join(', ')
      : '';

    const gapsContext = gapsList
      ? `\nADAPTIVE FOCUS: The student previously struggled with these conceptual gaps: "${gapsList}". Incorporate questions that verify whether these specific weak areas have been resolved.`
      : '';

    let historyContext = '';
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      historyContext = '\nPRIOR CONVERSATION CONTEXT:\n' +
        conversationHistory.slice(-6).map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.text}`).join('\n') + '\n';
    }

    const reasoningContext = orchestratorReasoning
      ? `\nORCHESTRATOR PEDAGOGICAL STRATEGY:\n${orchestratorReasoning}\n`
      : '';

    const prompt = `You are an expert adaptive academic tutor creating an exact ${targetCount}-question conceptual multiple-choice quiz.
Topic: "${topic}"
Target Academic Level & Difficulty: "${levelStr}"
Exact Question Count: ${targetCount} (You MUST generate exactly ${targetCount} questions, no more and no less).
${reasoningContext}${historyContext}${gapsContext}

CRITICAL CONTEXT ISOLATION:
- Focus 100% strictly on "${topic}".
- DO NOT mention, blend, or include questions on topics from previous chat sessions unless "${topic}" specifically encompasses them.

STRICT ACADEMIC LEVEL CALIBRATION (${levelStr}):
- Match vocabulary, complexity, mathematical/mechanism depth, and distractors strictly to a student at the "${levelStr}" standard.
  * If "High School" or "Beginner": Use clear, foundational terminology, relatable examples, avoiding hyper-specialized research jargon.
  * If "College" or "Advanced": Use rigorous technical terminology, analyze non-trivial edge cases, state functions, and deep theoretical mechanisms.
- All mathematical formulas, symbols, or equations MUST use clean LaTeX syntax (e.g. $E = mc^2$ or $\\Delta S \\ge 0$) so KaTeX renders them properly.
- CRITICAL FOR JSON: In string values, escape LaTeX backslashes as double backslashes (e.g. "\\\\Delta", "\\\\frac", "\\\\ge") so the output parses cleanly.
- Each question must have 4 distinct plausible options (A, B, C, D). Exactly one option must be unambiguously correct.

Return strictly valid JSON with this exact schema:
{
  "topic": "${topic}",
  "academic_level": "${levelStr}",
  "optimal_quiz_length": ${targetCount},
  "questions": [
    {
      "id": 1,
      "question": "Question statement...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_option": "Exact string of correct option",
      "concept_tested": "Brief tag of specific concept"
    }
  ]
}`;

    const result = await executeWithModel(
      (model) => model.generateContent(prompt),
      { generationConfig: { responseMimeType: 'application/json' } }
    );

    const parsed = safeJSONParse(result.response.text());

    let rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    if (rawQuestions.length === 0 && parsed.question) {
      rawQuestions = [parsed];
    }

    const sanitizedQuestions = rawQuestions.slice(0, targetCount).map((q, idx) => {
      let options = Array.isArray(q.options) ? q.options.map((opt) => decodeUnicodeEscapes(String(opt))) : [];
      if (options.length < 2) options = ['Option A', 'Option B', 'Option C', 'Option D'];

      let correctOption = decodeUnicodeEscapes(String(q.correct_option || '').trim());
      const matched = options.find((opt) => opt.toLowerCase() === correctOption.toLowerCase());
      if (matched) {
        correctOption = matched;
      } else {
        correctOption = options[0];
      }

      return {
        id: idx + 1,
        question: decodeUnicodeEscapes(String(q.question || `Question ${idx + 1} on ${topic}`)),
        options: options.slice(0, 4),
        correct_option: correctOption,
        concept_tested: decodeUnicodeEscapes(String(q.concept_tested || `${topic} Concept ${idx + 1}`))
      };
    });

    // Fill up to targetCount dynamically if model returned fewer
    while (sanitizedQuestions.length < targetCount) {
      const idx = sanitizedQuestions.length;
      sanitizedQuestions.push({
        id: idx + 1,
        question: `Question ${idx + 1}: How does the core mechanism of ${topic} operate under ${levelStr} constraints?`,
        options: [
          `Fundamental operational principle of ${topic}`,
          `Superficial secondary characteristic`,
          `Inverse of standard physical/computational behavior`,
          `Common student misconception`
        ],
        correct_option: `Fundamental operational principle of ${topic}`,
        concept_tested: `${topic} Core Concepts`
      });
    }

    return {
      topic: decodeUnicodeEscapes(String(parsed.topic || topic)),
      academic_level: levelStr,
      optimal_quiz_length: sanitizedQuestions.length,
      questions: sanitizedQuestions
    };
  } catch (error) {
    console.error('Error in generateAdaptiveQuiz:', error);
    const fallbackQuestions = [];
    for (let i = 1; i <= targetCount; i++) {
      fallbackQuestions.push({
        id: i,
        question: `Question ${i}: What fundamental principle defines ${topic} at the ${academicLevel || 'standard'} level?`,
        options: [
          `Core foundational mechanism of ${topic}`,
          `Superficial external factor`,
          `Opposite mechanism of ${topic}`,
          `Common misconception`
        ],
        correct_option: `Core foundational mechanism of ${topic}`,
        concept_tested: `${topic} Part ${i}`
      });
    }
    return {
      topic,
      academic_level: academicLevel || 'General',
      optimal_quiz_length: fallbackQuestions.length,
      questions: fallbackQuestions
    };
  }
}

/**
 * 3. explainConcept(topic, academicLevel, conversationHistory, knowledgeGaps, orchestratorReasoning, intent)
 * Speed-optimized: Generates standard Markdown directly (no heavy JSON serialization overhead).
 * Fully dynamic response formatting without hardcoded headings like 'Mechanics'.
 * Strictly isolates topic and prevents context mixing.
 */
async function explainConcept(
  topic,
  academicLevel = 'College',
  conversationHistory = [],
  knowledgeGaps = [],
  orchestratorReasoning = '',
  intent = 'TEACH'
) {
  try {
    const levelStr = String(academicLevel || 'College / Undergraduate').trim();
    const isDoubt = intent === 'CLARIFY_DOUBT';

    const gapsList = Array.isArray(knowledgeGaps) && knowledgeGaps.length > 0
      ? knowledgeGaps.map((g) => (typeof g === 'string' ? g : g.concept || '')).filter(Boolean).join(', ')
      : '';

    const gapsContext = gapsList
      ? `\nSTUDENT KNOWLEDGE GAPS: The student previously struggled with: "${gapsList}". If directly relevant to "${topic}", clarify these weak points naturally.`
      : '';

    const prompt = `You are a world-class AI academic tutor.
Topic: "${topic}"
Target Academic Level: "${levelStr}"
Pedagogical Intent: "${intent}" (${isDoubt ? 'Directly resolve the student doubt / confusion' : 'Comprehensive conceptual instruction'})
${gapsContext}

CRITICAL CONTEXT ISOLATION:
- Focus 100% exclusively on "${topic}".
- DO NOT reference, blend, or compare topics from earlier in the chat history unless the student explicitly asked to compare them.
- Present "${topic}" cleanly, completely, and independently.

DYNAMIC RESPONSE FORMATTING:
- Use your own expert pedagogical judgment to format the explanation freely using clean GitHub-flavored Markdown.
- Choose natural headings, bullet points, intuitive examples, and visual analogies that best suit "${topic}" and the "${levelStr}" standard.
- DO NOT use rigid, forced template headings (such as "Mechanics" or "Core Concept"). Structure the lesson organically and engagingly.
- All mathematical formulas, scientific laws, or equations MUST use clean LaTeX syntax ($...$ for inline and $$...$$ for display equations) so KaTeX renders them smoothly.

FOLLOW-UP QUICK ACTIONS:
At the very end of your response, provide 3 quick next-step action suggestions separated by this exact delimiter:
---SUGGESTIONS---
• [Quick Action 1]
• [Quick Action 2]
• [Quick Action 3]`;

    // Fast generation: standard Markdown text without JSON serialization latency
    const result = await executeWithModel((model) => model.generateContent(prompt));
    const rawText = decodeUnicodeEscapes(result.response.text());

    // Split markdown explanation and suggestions
    let explanation = rawText;
    let suggestions = [];

    if (rawText.includes('---SUGGESTIONS---')) {
      const parts = rawText.split('---SUGGESTIONS---');
      explanation = parts[0].trim();
      const rawSuggestions = parts[1] || '';
      suggestions = rawSuggestions
        .split('\n')
        .map((s) => s.replace(/^[•\-\*\d\.\s]+/, '').trim())
        .filter((s) => s.length > 3 && !s.includes('---'));
    }

    if (suggestions.length === 0) {
      suggestions = [
        `Take an Adaptive Quiz on ${topic}`,
        `Explore practical applications of ${topic}`,
        `Review foundational principles of ${topic}`
      ];
      if (gapsList && knowledgeGaps.length > 0) {
        suggestions.push(`Review Gap: ${typeof knowledgeGaps[0] === 'string' ? knowledgeGaps[0] : knowledgeGaps[0].concept}`);
      }
    }

    return {
      explanation,
      dynamic_suggestions: suggestions.slice(0, 4)
    };
  } catch (error) {
    console.error('Error in explainConcept:', error);
    return {
      explanation: `### Overview of ${topic}\n\n${topic} is a foundational concept at the ${academicLevel || 'academic'} standard.`,
      dynamic_suggestions: [
        `Take an Adaptive Quiz on ${topic}`,
        `Explain more with examples`,
        `Give an analogy for ${topic}`
      ]
    };
  }
}

/**
 * 3. analyzeBatchGapsAndTeach(batchResults, topic, academicLevel, knowledgeGaps)
 * Diagnoses root conceptual blind spots across questions, calibrated to academic level and prior gaps.
 */
async function analyzeBatchGapsAndTeach(batchResults, topic, academicLevel = 'College', knowledgeGaps = []) {
  try {
    const levelStr = String(academicLevel || 'College').trim();
    const summary = batchResults.map((r, i) => `
Question ${i + 1}: "${r.question}"
- Concept Tested: "${r.concept_tested}"
- Student Selected: "${r.selected_option}"
- Correct Answer: "${r.correct_option}"
- Result: ${r.is_correct ? 'CORRECT' : 'WRONG'}
`).join('\n');

    const prompt = `You are a master diagnostic tutor evaluating student responses on "${topic}".
Student Academic Level: "${levelStr}"
Performance Breakdown:
${summary}

Diagnose the student's pattern of responses across all questions:
1. Identify the single root conceptual blind spot or misunderstanding causing errors, calibrated to ${levelStr} expectations.
2. Synthesize an impactful 2-3 sentence micro-lesson directly addressing this misconception. Use LaTeX math ($...$) if relevant.
3. Provide an intuitive, memorable real-world analogy.
4. Provide 2-3 smart remedial suggestions (e.g. "Practice Quiz on [Blind Spot]", "Explain [Blind Spot]").

Return strictly valid JSON matching this schema:
{
  "blind_spot_tag": "A concise 2-4 word tag naming the root misconception (e.g. 'State Functions vs Path Functions')",
  "micro_lesson": "A friendly, impactful 2-3 sentence explanation addressing the exact misconception across these questions.",
  "analogy": "A relatable real-world analogy to solidify the correct mental model.",
  "dynamic_suggestions": ["Practice Quiz on ...", "Explain ..."]
}`;

    const result = await executeWithModel(
      (model) => model.generateContent(prompt),
      { generationConfig: { responseMimeType: 'application/json' } }
    );

    const parsed = safeJSONParse(result.response.text());

    const blindSpot = String(parsed.blind_spot_tag || `${topic} Conceptual Blind Spot`);
    let suggestions = Array.isArray(parsed.dynamic_suggestions) ? parsed.dynamic_suggestions.map(String) : [];
    if (suggestions.length === 0) {
      suggestions = [`Practice Quiz on ${blindSpot}`, `Explain ${blindSpot}`];
    }

    return {
      blind_spot_tag: blindSpot,
      micro_lesson: String(parsed.micro_lesson || `Review the relationship between the key mechanisms in ${topic}.`),
      analogy: String(parsed.analogy || `Think of it like balancing a budget: income must equal expenditures plus savings.`),
      dynamic_suggestions: suggestions.slice(0, 3)
    };
  } catch (error) {
    console.error('Error in analyzeBatchGapsAndTeach:', error);
    return {
      blind_spot_tag: `${topic} Core Misconception`,
      micro_lesson: `Across these questions, review how the fundamental principles of ${topic} behave under different constraints at the ${academicLevel} level.`,
      analogy: `Think of a bicycle gear system: changing one component adjusts the torque and speed across the entire drivetrain.`,
      dynamic_suggestions: [`Practice Quiz on ${topic}`, `Explain ${topic}`]
    };
  }
}

/**
 * 4. evaluateHandwrittenAnswer(base64Image, mimeType, question, academicLevel)
 */
async function evaluateHandwrittenAnswer(base64Image, mimeType, question, academicLevel = 'College') {
  try {
    const levelStr = String(academicLevel || 'College').trim();
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: mimeType || 'image/jpeg'
      }
    };

    const prompt = `You are a strict, action-oriented academic evaluator.
Student Academic Level: "${levelStr}"
Question: "${question || 'Explain the conceptual mechanism step by step'}"
Examine the handwritten work or diagram in the image.

Evaluate it accurately according to the standards of ${levelStr}.
All mathematical symbols or formulas in ideal_answer MUST use LaTeX syntax ($...$ or $$...$$).
Return strictly valid JSON matching this schema:
{
  "score_out_of_10": 8,
  "missing_concepts": [
    "Specific missing terminology or principle 1",
    "Specific missing formula or mechanism step 2"
  ],
  "ideal_answer": "Concise 3-4 sentence ideal answer covering all key technical points with LaTeX math."
}`;

    const result = await executeWithModel(
      (model) => model.generateContent([prompt, imagePart]),
      { generationConfig: { responseMimeType: 'application/json' } }
    );

    const parsed = safeJSONParse(result.response.text());

    return {
      score_out_of_10: typeof parsed.score_out_of_10 === 'number' ? parsed.score_out_of_10 : 7,
      missing_concepts: Array.isArray(parsed.missing_concepts) ? parsed.missing_concepts.map(String) : [],
      ideal_answer: String(parsed.ideal_answer || 'Clearly explain the core mechanism with appropriate technical terms.')
    };
  } catch (error) {
    console.error('Error in evaluateHandwrittenAnswer:', error);
    return {
      score_out_of_10: 6,
      missing_concepts: ['Clarity in handwritten explanation', 'Complete technical step formulation'],
      ideal_answer: `The ideal answer should directly address "${question}" with clear step-by-step reasoning.`
    };
  }
}

module.exports = {
  analyzeAndStrategize,
  generateAdaptiveQuiz,
  explainConcept,
  analyzeBatchGapsAndTeach,
  evaluateHandwrittenAnswer,
  extractTopicWithContext,
  isQuizIntent,
  safeJSONParse,
  decodeUnicodeEscapes
};
