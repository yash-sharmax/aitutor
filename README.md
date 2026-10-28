Adaptive AI Micro-Tutor 🧠

Code-E-Fiesta 2026 Hackathon Submission

An intelligent, web-based learning platform that identifies student knowledge gaps in real-time. Moving beyond generic LMS platforms, this tool generates personalized micro-lessons, adaptive quizzes, and evaluates handwritten subjective answers using multimodal AI.

Core Features

🎯 Adaptive MCQ Arena: Dynamically generates targeted questions. If a student answers incorrectly, the system identifies the exact conceptual blind spot and delivers a bite-sized remedial lesson before the next question.

📝 Vision AI Grader: Students can upload photos of their handwritten notebook answers. The system uses OCR and AI to grade the answer out of 10, highlight missing technical concepts, and provide an ideal solution.

📸 Instant Doubt & Socratic Viva Room: Accepts textbook diagram uploads for step-by-step doubt solving, or utilizes Web Speech APIs to conduct a voice-based interactive viva.

📊 Live Educator Dashboard: Real-time tracking of student accuracy, attempts, and auto-generated "Knowledge Gap" badges powered by Supabase.

Tech Stack

Backend: Node.js, Express.js

Database: Supabase (PostgreSQL)

AI Engine: Google Gemini 1.5 Flash (Text & Multimodal Vision)

Frontend: HTML5, Tailwind CSS, Chart.js

Local Setup & Installation

1. Clone the repository and install dependencies

git clone <repository-url>
cd code-e-fiesta-bot
npm install express cors multer @supabase/supabase-js @google/generative-ai dotenv


2. Configure Environment Variables
Create a .env file in the root directory and add your API keys:

GEMINI_API_KEY=your_gemini_api_key
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_public_key
PORT=3000


3. Initialize the Supabase Database
Run the following query in your Supabase SQL Editor:

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  current_topic TEXT DEFAULT 'General',
  score INT DEFAULT 0,
  total_attempts INT DEFAULT 0,
  knowledge_gaps JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  action_type TEXT NOT NULL,
  topic TEXT,
  is_correct BOOLEAN,
  gap_detected TEXT,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


4. Start the Server

node index.js


The web platform will be live at http://localhost:3000.
