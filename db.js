require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️ SUPABASE_URL or SUPABASE_KEY is missing in .env');
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Supabase client initialized connected to cloud DB.');

/**
 * Helper: getOrCreateStudent(username)
 */
async function getOrCreateStudent(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();

  let { data: student, error } = await supabase
    .from('students')
    .select('*')
    .eq('username', cleanUsername)
    .maybeSingle();

  if (!student) {
    const { data: newStudent } = await supabase
      .from('students')
      .insert({
        username: cleanUsername,
        score: 0,
        total_attempts: 0,
        knowledge_gaps: [],
        academic_level: null,
        conversation_history: []
      })
      .select()
      .maybeSingle();

    student = newStudent || { username: cleanUsername, score: 0, total_attempts: 0, knowledge_gaps: [], conversation_history: [] };
  }

  // Format JSON arrays safely
  if (typeof student.knowledge_gaps === 'string') {
    try { student.knowledge_gaps = JSON.parse(student.knowledge_gaps); } catch { student.knowledge_gaps = []; }
  }
  if (!Array.isArray(student.knowledge_gaps)) student.knowledge_gaps = [];

  if (typeof student.conversation_history === 'string') {
    try { student.conversation_history = JSON.parse(student.conversation_history); } catch { student.conversation_history = []; }
  }
  if (!Array.isArray(student.conversation_history)) student.conversation_history = [];

  return student;
}

/**
 * Helper: updateAcademicLevel
 */
async function updateAcademicLevel(username, level) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const cleanLevel = String(level || '').trim();
  await getOrCreateStudent(cleanUsername);

  await supabase
    .from('students')
    .update({
      academic_level: cleanLevel,
      updated_at: new Date().toISOString()
    })
    .eq('username', cleanUsername);

  return await getOrCreateStudent(cleanUsername);
}

/**
 * Helper: getChatHistory
 */
async function getChatHistory(username) {
  const student = await getOrCreateStudent(username);
  return student.conversation_history.slice(-20);
}

/**
 * Helper: updateChatHistory
 */
async function updateChatHistory(username, newMessagesArray) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const currentHistory = await getChatHistory(cleanUsername);

  const combined = Array.isArray(newMessagesArray)
    ? [...currentHistory, ...newMessagesArray]
    : [...currentHistory, newMessagesArray];

  const trimmed = combined.slice(-20);

  await supabase
    .from('students')
    .update({
      conversation_history: trimmed,
      updated_at: new Date().toISOString()
    })
    .eq('username', cleanUsername);

  return trimmed;
}

/**
 * Helper: clearChatHistory
 */
async function clearChatHistory(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  await supabase
    .from('students')
    .update({
      conversation_history: [],
      updated_at: new Date().toISOString()
    })
    .eq('username', cleanUsername);
  return [];
}

/**
 * Helper: deleteSessionHistory
 */
async function deleteSessionHistory(username, topic) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const currentHistory = await getChatHistory(cleanUsername);
  const cleanTopic = String(topic || '').trim().toLowerCase();

  const filtered = currentHistory.filter((m) => {
    if (!m) return false;
    const msgTopic = String(m.topic || (m.role === 'user' ? m.text : '')).toLowerCase();
    return !msgTopic.includes(cleanTopic);
  });

  await supabase
    .from('students')
    .update({
      conversation_history: filtered,
      updated_at: new Date().toISOString()
    })
    .eq('username', cleanUsername);

  return filtered;
}

/**
 * Helper: recordAttempt (For Polls & Tests)
 */
async function recordAttempt(username, topic, isCorrect, gapConcept, actionType, details) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const student = await getOrCreateStudent(cleanUsername);

  const scoreIncrement = isCorrect ? 10 : 0;
  const newScore = (student.score || 0) + scoreIncrement;
  const newAttempts = (student.total_attempts || 0) + 1;

  let gaps = [...student.knowledge_gaps];
  if (!isCorrect && gapConcept && typeof gapConcept === 'string') {
    const cleanGap = gapConcept.trim();
    const alreadyExists = gaps.some((g) => {
      const val = typeof g === 'string' ? g : g.concept || '';
      return val.toLowerCase() === cleanGap.toLowerCase();
    });
    if (cleanGap && !alreadyExists) {
      gaps.push(cleanGap);
    }
  }

  // 1. Update Student Stats
  await supabase
    .from('students')
    .update({
      score: newScore,
      total_attempts: newAttempts,
      knowledge_gaps: gaps,
      updated_at: new Date().toISOString()
    })
    .eq('username', cleanUsername);

  // 2. Insert Activity Log
  await supabase
    .from('activity_logs')
    .insert({
      username: cleanUsername,
      topic: topic || 'General',
      is_correct: Boolean(isCorrect),
      gap_concept: gapConcept || null,
      action_type: actionType || 'quiz',
      details: typeof details === 'object' ? details : { note: String(details || '') }
    });

  return {
    username: cleanUsername,
    score: newScore,
    total_attempts: newAttempts,
    knowledge_gaps: gaps,
    academic_level: student.academic_level
  };
}

/**
 * Helper: getDashboardAnalytics
 */
async function getDashboardAnalytics(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const student = await getOrCreateStudent(cleanUsername);
  let logs = [];

  const { data } = await supabase
    .from('activity_logs')
    .select('*')
    .eq('username', cleanUsername)
    .order('created_at', { ascending: false })
    .limit(20);

  if (data) {
    logs = data;
  }

  const score = student.score || 0;
  const attempts = student.total_attempts || 0;
  const accuracy = attempts > 0 ? Math.min(100, Math.round((score / (attempts * 10)) * 100)) : 0;

  return {
    student: {
      username: cleanUsername,
      score,
      total_attempts: attempts,
      accuracy,
      academic_level: student.academic_level || null
    },
    knowledge_gaps: student.knowledge_gaps,
    activity_logs: logs
  };
}

module.exports = {
  getOrCreateStudent,
  updateAcademicLevel,
  getChatHistory,
  updateChatHistory,
  clearChatHistory,
  deleteSessionHistory,
  recordAttempt,
  getDashboardAnalytics,
  supabase
};