require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialized:', supabaseUrl);
  } catch (err) {
    console.error('⚠️ Failed to initialize Supabase client:', err.message);
  }
} else {
  console.warn('⚠️ SUPABASE_URL or SUPABASE_KEY is missing in .env');
}

// 2. Local SQLite persistence (ensures zero data loss if Supabase RLS is enabled)
const DB_PATH = path.join(__dirname, 'tutor.db');
let localDb = null;

function getLocalDB() {
  if (localDb) return Promise.resolve(localDb);

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      localDb = db;
      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS web_students (
            username TEXT PRIMARY KEY,
            score INTEGER DEFAULT 0,
            total_attempts INTEGER DEFAULT 0,
            knowledge_gaps TEXT DEFAULT '[]',
            academic_level TEXT DEFAULT NULL,
            conversation_history TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Ensure columns exist if table was created in an earlier migration
        db.run(`ALTER TABLE web_students ADD COLUMN academic_level TEXT DEFAULT NULL`, () => {});
        db.run(`ALTER TABLE web_students ADD COLUMN conversation_history TEXT DEFAULT '[]'`, () => {});

        db.run(`
          CREATE TABLE IF NOT EXISTS web_activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            topic TEXT,
            is_correct INTEGER DEFAULT 0,
            gap_concept TEXT,
            action_type TEXT,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (createErr) => {
          if (createErr) return reject(createErr);
          resolve(localDb);
        });
      });
    });
  });
}

// Initialize tables on load
getLocalDB().catch((err) => console.error('Local DB initialization error:', err));

// Helpers for Local Store
async function localGetOrCreateStudent(username) {
  const db = await getLocalDB();
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM web_students WHERE username = ?', [username], (err, row) => {
      if (err) return reject(err);
      if (row) {
        let gaps = [];
        try { gaps = JSON.parse(row.knowledge_gaps); } catch { gaps = []; }
        let history = [];
        try { history = JSON.parse(row.conversation_history); } catch { history = []; }

        return resolve({
          username: row.username,
          score: row.score || 0,
          total_attempts: row.total_attempts || 0,
          knowledge_gaps: gaps,
          academic_level: row.academic_level || null,
          conversation_history: history,
          created_at: row.created_at,
          updated_at: row.updated_at
        });
      }

      const defaultStudent = {
        username,
        score: 0,
        total_attempts: 0,
        knowledge_gaps: [],
        academic_level: null,
        conversation_history: []
      };

      db.run(
        'INSERT INTO web_students (username, score, total_attempts, knowledge_gaps, academic_level, conversation_history) VALUES (?, 0, 0, ?, NULL, ?)',
        [username, JSON.stringify([]), JSON.stringify([])],
        (insertErr) => {
          if (insertErr) return reject(insertErr);
          resolve(defaultStudent);
        }
      );
    });
  });
}

async function localUpsertStudent(student) {
  const db = await getLocalDB();
  const gapsStr = Array.isArray(student.knowledge_gaps)
    ? JSON.stringify(student.knowledge_gaps)
    : (student.knowledge_gaps || '[]');
  const historyStr = Array.isArray(student.conversation_history)
    ? JSON.stringify(student.conversation_history)
    : (student.conversation_history || '[]');

  return new Promise((resolve) => {
    db.run(
      `INSERT INTO web_students (username, score, total_attempts, knowledge_gaps, academic_level, conversation_history, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(username) DO UPDATE SET
         score = excluded.score,
         total_attempts = excluded.total_attempts,
         knowledge_gaps = excluded.knowledge_gaps,
         academic_level = COALESCE(excluded.academic_level, web_students.academic_level),
         conversation_history = excluded.conversation_history,
         updated_at = CURRENT_TIMESTAMP`,
      [student.username, student.score || 0, student.total_attempts || 0, gapsStr, student.academic_level || null, historyStr],
      () => resolve()
    );
  });
}

async function localRecordAttempt(username, score, totalAttempts, gaps, topic, isCorrect, gapConcept, actionType, details) {
  const db = await getLocalDB();
  const gapsStr = JSON.stringify(gaps);
  const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');

  return new Promise((resolve) => {
    db.serialize(() => {
      db.run(
        `INSERT INTO web_students (username, score, total_attempts, knowledge_gaps, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(username) DO UPDATE SET
           score = excluded.score,
           total_attempts = excluded.total_attempts,
           knowledge_gaps = excluded.knowledge_gaps,
           updated_at = CURRENT_TIMESTAMP`,
        [username, score, totalAttempts, gapsStr]
      );

      db.run(
        `INSERT INTO web_activity_logs (username, topic, is_correct, gap_concept, action_type, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [username, topic, isCorrect ? 1 : 0, gapConcept || null, actionType || 'quiz', detailsStr],
        () => resolve()
      );
    });
  });
}

async function localGetLogs(username) {
  const db = await getLocalDB();
  return new Promise((resolve) => {
    db.all(
      'SELECT * FROM web_activity_logs WHERE username = ? ORDER BY id DESC LIMIT 20',
      [username],
      (err, rows) => {
        if (err || !rows) return resolve([]);
        const parsed = rows.map((r) => {
          let details = r.details;
          try { details = JSON.parse(r.details); } catch {}
          return {
            id: r.id,
            username: r.username,
            topic: r.topic,
            is_correct: Boolean(r.is_correct),
            gap_concept: r.gap_concept,
            action_type: r.action_type,
            details,
            created_at: r.created_at
          };
        });
        resolve(parsed);
      }
    );
  });
}

/**
 * Export 1: getOrCreateStudent(username)
 */
async function getOrCreateStudent(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  let student = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('username', cleanUsername)
        .maybeSingle();

      if (!error && data) {
        student = data;
      } else if (!error && !data) {
        const { data: newStudent, error: insertError } = await supabase
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

        if (!insertError && newStudent) {
          student = newStudent;
        }
      }
    } catch (e) {
      console.warn('Supabase query error:', e.message);
    }
  }

  if (!student) {
    student = await localGetOrCreateStudent(cleanUsername);
  } else {
    // Sync local store
    const local = await localGetOrCreateStudent(cleanUsername);
    if (!student.academic_level && local.academic_level) {
      student.academic_level = local.academic_level;
    }
    // Only copy history from local if student.conversation_history is undefined/null
    // (Never overwrite an explicit empty array [] with old local history)
    if (student.conversation_history === undefined || student.conversation_history === null) {
      student.conversation_history = local.conversation_history || [];
    }
    await localUpsertStudent(student);
  }

  // Format gaps as array
  if (typeof student.knowledge_gaps === 'string') {
    try { student.knowledge_gaps = JSON.parse(student.knowledge_gaps); } catch { student.knowledge_gaps = []; }
  }
  if (!Array.isArray(student.knowledge_gaps)) {
    student.knowledge_gaps = [];
  }

  // Format history as array
  if (typeof student.conversation_history === 'string') {
    try { student.conversation_history = JSON.parse(student.conversation_history); } catch { student.conversation_history = []; }
  }
  if (!Array.isArray(student.conversation_history)) {
    student.conversation_history = [];
  }

  if (!student.academic_level) {
    student.academic_level = null;
  }

  return student;
}

/**
 * Export 2: updateAcademicLevel(username, level)
 */
async function updateAcademicLevel(username, level) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const cleanLevel = String(level || '').trim();

  // Ensure student row exists first
  await getOrCreateStudent(cleanUsername);

  if (supabase) {
    try {
      await supabase
        .from('students')
        .update({
          academic_level: cleanLevel,
          updated_at: new Date().toISOString()
        })
        .eq('username', cleanUsername);
    } catch (e) {
      console.warn('Supabase updateAcademicLevel warning:', e.message);
    }
  }

  const db = await getLocalDB();
  await new Promise((resolve) => {
    db.run(
      `UPDATE web_students SET academic_level = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`,
      [cleanLevel, cleanUsername],
      () => resolve()
    );
  });

  return await getOrCreateStudent(cleanUsername);
}

/**
 * Export 3: getChatHistory(username)
 * Fetches last messages (up to 20)
 */
async function getChatHistory(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const student = await getOrCreateStudent(cleanUsername);
  const history = Array.isArray(student.conversation_history) ? student.conversation_history : [];
  return history.slice(-20);
}

/**
 * Export 4: updateChatHistory(username, newMessagesArray)
 * Appends messages and keeps the last 20 entries
 */
async function updateChatHistory(username, newMessagesArray) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  await getOrCreateStudent(cleanUsername);
  const currentHistory = await getChatHistory(cleanUsername);

  const combined = Array.isArray(newMessagesArray)
    ? [...currentHistory, ...newMessagesArray]
    : [...currentHistory, newMessagesArray];

  // Limit to last 20 messages to conserve tokens
  const trimmed = combined.slice(-20);
  const historyStr = JSON.stringify(trimmed);

  // 1. Try Supabase
  if (supabase) {
    try {
      await supabase
        .from('students')
        .update({
          conversation_history: trimmed,
          updated_at: new Date().toISOString()
        })
        .eq('username', cleanUsername);
    } catch (e) {
      console.warn('Supabase updateChatHistory warning:', e.message);
    }
  }

  // 2. Persist locally
  const db = await getLocalDB();
  await new Promise((resolve) => {
    db.run(
      `UPDATE web_students SET conversation_history = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`,
      [historyStr, cleanUsername],
      () => resolve()
    );
  });

  return trimmed;
}

/**
 * Export 5: clearChatHistory(username)
 * Completely wipes the conversation_history in Supabase and local store
 */
async function clearChatHistory(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();

  // 1. Wipe in Supabase
  if (supabase) {
    try {
      const { error } = await supabase
        .from('students')
        .update({
          conversation_history: [],
          updated_at: new Date().toISOString()
        })
        .eq('username', cleanUsername);
      if (error) {
        console.warn('Supabase clearChatHistory warning:', error.message);
      } else {
        console.log(`[Supabase] Successfully wiped conversation_history for ${cleanUsername}`);
      }
    } catch (e) {
      console.warn('Supabase clearChatHistory warning:', e.message);
    }
  }

  // 2. Wipe in Local SQLite store
  const db = await getLocalDB();
  await new Promise((resolve) => {
    db.run(
      `UPDATE web_students SET conversation_history = '[]', updated_at = CURRENT_TIMESTAMP WHERE username = ?`,
      [cleanUsername],
      () => resolve()
    );
  });

  console.log(`[DB] Successfully cleared conversation_history for user: ${cleanUsername}`);
  return [];
}

/**
 * Export 5b: deleteSessionHistory(username, topic)
 * Deletes a specific conversation topic session from user history
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

  const historyStr = JSON.stringify(filtered);

  if (supabase) {
    try {
      await supabase
        .from('students')
        .update({
          conversation_history: filtered,
          updated_at: new Date().toISOString()
        })
        .eq('username', cleanUsername);
    } catch (e) {
      console.warn('Supabase deleteSessionHistory warning:', e.message);
    }
  }

  const db = await getLocalDB();
  await new Promise((resolve) => {
    db.run(
      `UPDATE web_students SET conversation_history = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`,
      [historyStr, cleanUsername],
      () => resolve()
    );
  });

  return filtered;
}

/**
 * Export 6: recordAttempt(username, topic, isCorrect, gapConcept, actionType, details)
 */
async function recordAttempt(username, topic, isCorrect, gapConcept, actionType, details) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const student = await getOrCreateStudent(cleanUsername);

  const scoreIncrement = isCorrect ? 10 : 0;
  const newScore = (student.score || 0) + scoreIncrement;
  const newAttempts = (student.total_attempts || 0) + 1;

  let gaps = Array.isArray(student.knowledge_gaps) ? [...student.knowledge_gaps] : [];
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

  // Try Supabase first
  if (supabase) {
    try {
      await supabase
        .from('students')
        .update({
          score: newScore,
          total_attempts: newAttempts,
          knowledge_gaps: gaps,
          updated_at: new Date().toISOString()
        })
        .eq('username', cleanUsername);

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
    } catch (e) {
      console.warn('Supabase recordAttempt warning:', e.message);
    }
  }

  // Persist locally
  await localRecordAttempt(
    cleanUsername,
    newScore,
    newAttempts,
    gaps,
    topic,
    isCorrect,
    gapConcept,
    actionType,
    details
  );

  return {
    username: cleanUsername,
    score: newScore,
    total_attempts: newAttempts,
    knowledge_gaps: gaps,
    academic_level: student.academic_level
  };
}

/**
 * Export 7: getDashboardAnalytics(username)
 */
async function getDashboardAnalytics(username) {
  const cleanUsername = String(username || 'guest').trim().toLowerCase();
  const student = await getOrCreateStudent(cleanUsername);
  let logs = [];

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('activity_logs')
        .select('*')
        .eq('username', cleanUsername)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!error && Array.isArray(data) && data.length > 0) {
        logs = data;
      }
    } catch (e) {
      console.warn('Supabase getDashboardAnalytics warning:', e.message);
    }
  }

  if (logs.length === 0) {
    logs = await localGetLogs(cleanUsername);
  }

  const score = student.score || 0;
  const attempts = student.total_attempts || 0;
  const accuracy = attempts > 0 ? Math.min(100, Math.round((score / (attempts * 10)) * 100)) : 0;
  const gaps = Array.isArray(student.knowledge_gaps) ? student.knowledge_gaps : [];

  return {
    student: {
      username: cleanUsername,
      score,
      total_attempts: attempts,
      accuracy,
      academic_level: student.academic_level || null
    },
    knowledge_gaps: gaps,
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
