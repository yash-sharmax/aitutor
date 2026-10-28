require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer Memory Storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Helper: Determine if query is asking for a quiz
function isQuizIntent(text) {
  const lower = String(text || '').toLowerCase().trim();
  return (
    lower.includes('quiz') ||
    lower.includes('test me') ||
    lower.includes('test on') ||
    lower.includes('give me a quiz') ||
    lower.includes('mcq') ||
    lower.includes('questions')
  );
}

// Helper: Extract core topic from query, resolving pronouns from context if available
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
        if (prevClean && !/^(that|this|it|this topic|that topic|the topic|same|the same|same topic)$/i.test(prevClean) && !isAcademicLevelInput(prevClean)) {
          return prevClean;
        }
      }
    }
  }

  return clean || 'General Science';
}

function extractTopic(text) {
  return extractTopicWithContext(text, []);
}

// Helper: Identify if text is specifying an academic level
function isAcademicLevelInput(text) {
  const lower = String(text || '').toLowerCase().trim();
  const knownLevels = [
    'high school', 'college', 'beginner', 'undergraduate',
    'postgraduate', 'middle school', 'elementary', 'advanced',
    '10th grade', '11th grade', '12th grade', 'freshman', 'sophomore',
    'junior', 'senior', 'college 1st year', 'college 2nd year',
    'college 3rd year', 'college 4th year', 'phd', 'masters', 'intermediate'
  ];
  return knownLevels.some((lvl) => lower === lvl || lower.includes(lvl));
}

// REST Endpoints

/**
 * 1. POST /api/login: User session & student creation
 */
app.post('/api/login', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const student = await db.getOrCreateStudent(username.trim());
    res.json({ success: true, student });
  } catch (err) {
    console.error('Error in /api/login:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. POST /api/level: Explicit academic level update
 */
app.post('/api/level', async (req, res) => {
  try {
    const { username, level } = req.body;
    if (!username || !level) {
      return res.status(400).json({ error: 'Username and level are required' });
    }
    const student = await db.updateAcademicLevel(username, level);
    res.json({ success: true, student });
  } catch (err) {
    console.error('Error in /api/level:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3. POST /api/chat/new & POST /api/chat/clear: Clear Conversation History & Context Memory
 * Completely wipes the conversation_history array in Supabase and local store
 */
app.post(['/api/chat/new', '/api/chat/clear'], async (req, res) => {
  try {
    const rawUsername = (req.body && req.body.username) ? req.body.username : 'alex';
    const cleanUsername = String(rawUsername).trim();
    console.log(`[API] Wiping conversation history for student: "${cleanUsername}"`);
    await db.clearChatHistory(cleanUsername);
    res.json({ success: true, message: 'Conversation memory reset successfully', history: [] });
  } catch (err) {
    console.error('Error in /api/chat/new:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3b. POST /api/chat/delete-session: Delete single topic session or reset all
 */
app.post('/api/chat/delete-session', async (req, res) => {
  try {
    const { username, topic } = req.body;
    const cleanUsername = String(username || 'alex').trim();
    if (topic && topic.trim()) {
      const remaining = await db.deleteSessionHistory(cleanUsername, topic.trim());
      console.log(`[API] Deleted session "${topic}" for ${cleanUsername}. Remaining: ${remaining.length}`);
      res.json({ success: true, message: `Session "${topic}" deleted`, remaining_count: remaining.length });
    } else {
      await db.clearChatHistory(cleanUsername);
      console.log(`[API] Wiped all sessions for ${cleanUsername}`);
      res.json({ success: true, message: 'All sessions deleted', remaining_count: 0 });
    }
  } catch (err) {
    console.error('Error in /api/chat/delete-session:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3b. GET /api/history/:username: Fetch conversation history sessions for Left Sidebar
 */
app.get('/api/history/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const history = await db.getChatHistory(username);

    // Extract clean session topics for the History Sidebar
    const sessions = [];
    const seenTopics = new Set();

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg) continue;
      const topicName = msg.topic || (msg.role === 'user' ? msg.text : null);
      if (topicName && typeof topicName === 'string') {
        const cleanTopic = topicName.replace(/^\[Uploaded Image\]:\s*/i, '').trim();
        const key = cleanTopic.toLowerCase().slice(0, 30);
        if (cleanTopic.length > 2 && !seenTopics.has(key)) {
          seenTopics.add(key);
          sessions.push({
            topic: cleanTopic.length > 28 ? cleanTopic.slice(0, 26) + '...' : cleanTopic,
            full_topic: cleanTopic,
            role: msg.role
          });
        }
      }
    }

    res.json({ success: true, history, sessions });
  } catch (err) {
    console.error('Error in /api/history/:username:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4. POST /api/chat: Unified Action-Chat Router Endpoint
 * Injects memory from conversation_history, adapts to academic_level,
 * generates context-aware suggestions tied to knowledge gaps, and routes between Direct Quiz and Explain.
 */
app.post('/api/chat', upload.single('image'), async (req, res) => {
  try {
    const username = req.body.username || 'guest';
    const rawText = (req.body.text || req.body.message || req.body.topic || req.body.prompt || '').trim();
    const student = await db.getOrCreateStudent(username);
    const history = await db.getChatHistory(username);
    const knownGaps = Array.isArray(student.knowledge_gaps) ? student.knowledge_gaps : [];
    console.log(`[Chat Context] User: "${username}", History Items: ${history.length}, Known Gaps: ${knownGaps.length}`);

    // CASE A: User uploaded an image (Handwritten work / Diagram)
    if (req.file) {
      const base64Image = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype || 'image/jpeg';
      const question = rawText || 'Explain the conceptual mechanism step by step';
      const topic = req.body.topic || 'Visual Evaluation';

      const evaluation = await ai.evaluateHandwrittenAnswer(
        base64Image,
        mimeType,
        question,
        student.academic_level || 'College'
      );
      const isCorrect = (evaluation.score_out_of_10 || 0) >= 7;

      const gapTag = !isCorrect && Array.isArray(evaluation.missing_concepts) && evaluation.missing_concepts.length > 0
        ? evaluation.missing_concepts[0]
        : null;

      const stats = await db.recordAttempt(
        username,
        topic,
        isCorrect,
        gapTag,
        'written_eval',
        { question, evaluation }
      );

      // Record in memory
      await db.updateChatHistory(username, [
        { role: 'user', text: `[Uploaded Image]: ${question}` },
        { role: 'model', text: `Evaluation Score: ${evaluation.score_out_of_10}/10. Missing: ${(evaluation.missing_concepts || []).join(', ')}` }
      ]);

      return res.json({
        success: true,
        widget_type: 'evaluation_card',
        topic,
        question,
        evaluation,
        is_correct: isCorrect,
        stats
      });
    }

    // CASE B: User is responding with their Academic Level
    if (isAcademicLevelInput(rawText) || req.body.is_level_selection) {
      const cleanLevel = rawText;
      const updatedStudent = await db.updateAcademicLevel(username, cleanLevel);
      const pendingTopic = (req.body.pending_topic || '').trim();

      // Record in history
      await db.updateChatHistory(username, [
        { role: 'user', text: `My academic level is ${cleanLevel}` },
        { role: 'model', text: `Set standard to ${cleanLevel}` }
      ]);

      if (pendingTopic) {
        // Use Dynamic AI Orchestrator to drive pending topic strategy
        const strategy = await ai.analyzeAndStrategize(pendingTopic, history, {
          ...updatedStudent,
          academic_level: cleanLevel
        });

        if (strategy.intent === 'QUIZ') {
          const quizLength = Math.max(3, Math.min(15, parseInt(strategy.optimal_quiz_length, 10) || 5));
          const quiz = await ai.generateAdaptiveQuiz(
            strategy.derived_topic,
            updatedStudent.knowledge_gaps,
            strategy.difficulty || cleanLevel,
            quizLength,
            history,
            strategy.reasoning
          );

          await db.updateChatHistory(username, [
            { role: 'user', text: pendingTopic, topic: strategy.derived_topic },
            { role: 'model', text: `Generated ${quiz.questions.length}-question diagnostic quiz on ${strategy.derived_topic}. Strategy: ${strategy.reasoning}`, topic: strategy.derived_topic }
          ]);

          return res.json({
            success: true,
            widget_type: 'quiz_batch',
            topic: quiz.topic || strategy.derived_topic,
            academic_level: strategy.difficulty || cleanLevel,
            questions: quiz.questions,
            optimal_quiz_length: quiz.questions.length,
            intro_message: `Here is your diagnostic quiz on **${quiz.topic || strategy.derived_topic}** (${quiz.questions.length} questions):`
          });
        } else {
          const explainData = await ai.explainConcept(
            strategy.derived_topic,
            strategy.difficulty || cleanLevel,
            history,
            knownGaps,
            strategy.reasoning,
            strategy.intent
          );

          await db.updateChatHistory(username, [
            { role: 'user', text: pendingTopic, topic: strategy.derived_topic },
            { role: 'model', text: explainData.explanation.slice(0, 300), topic: strategy.derived_topic }
          ]);

          return res.json({
            success: true,
            widget_type: 'explanation',
            topic: strategy.derived_topic,
            academic_level: strategy.difficulty || cleanLevel,
            explanation: explainData.explanation,
            intro_message: '',
            dynamic_suggestions: explainData.dynamic_suggestions
          });
        }
      }

      const defaultSuggestions = ['Quiz on C++', 'Explain Thermodynamics', 'Quiz on Photosynthesis', 'Newton Laws'];
      if (knownGaps.length > 0) {
        defaultSuggestions.unshift(`Review Gap: ${knownGaps[0]}`);
      }

      return res.json({
        success: true,
        widget_type: 'level_confirmed',
        academic_level: cleanLevel,
        message: `Awesome! I've set your academic standard to **${cleanLevel}**. All explanations and quizzes will strictly calibrate vocabulary and depth to this level. What topic would you like to explore?`,
        dynamic_suggestions: defaultSuggestions.slice(0, 4)
      });
    }

    // CASE C: Level Profiling Check — If academic_level is null, prompt user first!
    if (!student.academic_level) {
      return res.json({
        success: true,
        widget_type: 'ask_level',
        pending_topic: rawText,
        message: `Before we dive in, what is your current academic level? (e.g. High School, College, Beginner, etc.)\nThis ensures the difficulty and terminology are tuned to your exact standard!`,
        dynamic_suggestions: ['High School', 'College', 'Beginner', 'Advanced / Competitive']
      });
    }

    // CASE D: Dynamic AI Orchestrator Execution!
    // Completely replaces hardcoded question counts and rigid regex matching.
    const userLevel = student.academic_level;
    const strategy = await ai.analyzeAndStrategize(rawText, history, student);
    console.log(`[AI Orchestrator] User: "${rawText}" -> Intent: ${strategy.intent}, Topic: "${strategy.derived_topic}", Length: ${strategy.optimal_quiz_length}, Difficulty: "${strategy.difficulty}"`);

    if (strategy.intent === 'QUIZ') {
      const quizLength = Math.max(3, Math.min(15, parseInt(strategy.optimal_quiz_length, 10) || 5));
      const quiz = await ai.generateAdaptiveQuiz(
        strategy.derived_topic,
        student.knowledge_gaps,
        strategy.difficulty || userLevel,
        quizLength,
        history,
        strategy.reasoning
      );

      // Record in memory
      await db.updateChatHistory(username, [
        { role: 'user', text: rawText, topic: strategy.derived_topic },
        { role: 'model', text: `Generated ${quiz.questions.length}-question diagnostic quiz on ${strategy.derived_topic}.`, topic: strategy.derived_topic }
      ]);

      return res.json({
        success: true,
        widget_type: 'quiz_batch',
        topic: quiz.topic || strategy.derived_topic,
        academic_level: strategy.difficulty || userLevel,
        questions: quiz.questions,
        optimal_quiz_length: quiz.questions.length,
        intro_message: `Here is your diagnostic quiz on **${quiz.topic || strategy.derived_topic}** (${quiz.questions.length} questions):`
      });
    } else {
      // Intent is TEACH or CLARIFY_DOUBT
      const explainData = await ai.explainConcept(
        strategy.derived_topic,
        strategy.difficulty || userLevel,
        history,
        knownGaps,
        strategy.reasoning,
        strategy.intent
      );

      // Record in memory
      await db.updateChatHistory(username, [
        { role: 'user', text: rawText, topic: strategy.derived_topic },
        { role: 'model', text: explainData.explanation.slice(0, 300), topic: strategy.derived_topic }
      ]);

      return res.json({
        success: true,
        widget_type: 'explanation',
        topic: strategy.derived_topic,
        academic_level: strategy.difficulty || userLevel,
        explanation: explainData.explanation,
        intro_message: '',
        dynamic_suggestions: explainData.dynamic_suggestions
      });
    }
  } catch (err) {
    console.error('Error in /api/chat:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 5. POST /api/submit: Batch Gap Analysis Submission
 * Analyzes answers across all questions to deduce a root conceptual blind spot.
 */
app.post('/api/submit', async (req, res) => {
  try {
    const { username, topic, batch_answers } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!Array.isArray(batch_answers) || batch_answers.length === 0) {
      return res.status(400).json({ error: 'batch_answers array is required' });
    }

    const student = await db.getOrCreateStudent(username);
    const userLevel = student.academic_level || 'College';
    const knownGaps = Array.isArray(student.knowledge_gaps) ? student.knowledge_gaps : [];
    console.log(`[Chat Context] User: "${username}", History Items: ${history.length}, Known Gaps: ${knownGaps.length}`);

    // Evaluate each question
    const evaluatedResults = batch_answers.map((item) => {
      const selected = String(item.selected_option || '').trim().toLowerCase();
      const correct = String(item.correct_option || '').trim().toLowerCase();
      const isCorrect = selected === correct;
      return {
        ...item,
        is_correct: isCorrect
      };
    });

    const correctCount = evaluatedResults.filter((item) => item.is_correct).length;
    const isAllCorrect = evaluatedResults.every((item) => item.is_correct);

    if (isAllCorrect) {
      const stats = await db.recordAttempt(
        username,
        topic || 'General',
        true,
        null,
        'quiz_batch',
        { results: evaluatedResults }
      );

      // Record in memory
      await db.updateChatHistory(username, [
        { role: 'model', text: `Student aced the ${evaluatedResults.length}-question quiz on ${topic} with 100% accuracy!`, topic }
      ]);

      const suggestions = ['Take another Quiz', `Explain advanced ${topic}`];
      if (knownGaps.length > 0) {
        suggestions.push(`Review Gap: ${knownGaps[0]}`);
      } else {
        suggestions.push('Choose new topic');
      }

      return res.json({
        success: true,
        is_all_correct: true,
        score_awarded: evaluatedResults.length * 10,
        widget_type: 'success_card',
        message: `Outstanding! All ${evaluatedResults.length} questions answered with complete conceptual mastery (${userLevel} level).`,
        results: evaluatedResults,
        stats,
        dynamic_suggestions: suggestions
      });
    } else {
      // Cross-question gap analysis
      const analysis = await ai.analyzeBatchGapsAndTeach(
        evaluatedResults,
        topic || 'General',
        userLevel,
        knownGaps
      );

      const stats = await db.recordAttempt(
        username,
        topic || 'General',
        false,
        analysis.blind_spot_tag,
        'quiz_batch',
        { results: evaluatedResults, analysis }
      );

      // Record in memory
      await db.updateChatHistory(username, [
        { role: 'model', text: `Diagnosed blind spot: ${analysis.blind_spot_tag} on ${topic}. Lesson: ${analysis.micro_lesson}`, topic }
      ]);

      return res.json({
        success: true,
        is_all_correct: false,
        correct_count: correctCount,
        total_count: evaluatedResults.length,
        widget_type: 'micro_lesson',
        analysis,
        results: evaluatedResults,
        stats,
        dynamic_suggestions: analysis.dynamic_suggestions || [
          `Practice Quiz on ${analysis.blind_spot_tag}`,
          `Explain ${analysis.blind_spot_tag}`
        ]
      });
    }
  } catch (err) {
    console.error('Error in /api/submit:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 6. GET /api/analytics/:username: Dashboard Metrics & Gaps
 */
app.get('/api/analytics/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const analytics = await db.getDashboardAnalytics(username);
    res.json({ success: true, ...analytics });
  } catch (err) {
    console.error('Error in /api/analytics/:username:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
