// Trigger Vercel rebuild to apply environment variables
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Path to data file (for local fallback storage)
// Connect to MongoDB if MONGODB_URI is provided
const isMongoEnabled = !!process.env.MONGODB_URI;

// Path to data file (for local fallback storage)
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'submissions.json');

// Ensure data directory and file exist for fallback ONLY if MongoDB is not enabled
if (!isMongoEnabled) {
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.error('Failed to create local data dir:', e);
    }
  }
  if (!fs.existsSync(DATA_FILE)) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to create local data file:', e);
    }
  }
}
if (isMongoEnabled) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB database successfully.'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.log('No MONGODB_URI provided. Falling back to local JSON file storage.');
}

// Define Schema for MongoDB
const submissionSchema = new mongoose.Schema({
  type: { type: String, required: true },
  name: { type: String, required: true },
  className: { type: String, default: '-' },
  answers: { type: mongoose.Schema.Types.Mixed, default: null },
  score: { type: Number, default: null },
  maxScore: { type: Number, default: null },
  teacherScore: { type: Number, default: null },
  teacherFeedback: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now }
});

const Submission = mongoose.models.Submission || mongoose.model('Submission', submissionSchema);

// Helper functions to read/write JSON file (fallback)
const readSubmissions = () => {
  try {
    const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    console.error('Error reading submissions file:', error);
    return [];
  }
};

const writeSubmissions = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing to submissions file:', error);
    return false;
  }
};

// API Routes

// 1. Submit LKS Answers or Quiz Score
app.post('/api/submissions', async (req, res) => {
  const { type, name, className, answers, score, maxScore } = req.body;

  if (!type || !name) {
    return res.status(400).json({ error: 'Tipe submission dan Nama harus diisi.' });
  }

  const payload = {
    type,
    name,
    className: className || '-',
    answers: answers || null,
    score: score !== undefined ? score : null,
    maxScore: maxScore !== undefined ? maxScore : null,
    timestamp: new Date().toISOString()
  };

  if (isMongoEnabled) {
    try {
      const sub = new Submission(payload);
      await sub.save();
      console.log(`[MongoDB Submission Success] ${type} from ${name}`);
      res.status(201).json({ 
        message: 'Submission berhasil disimpan!', 
        data: sub 
      });
    } catch (error) {
      console.error('Error saving to MongoDB:', error);
      res.status(500).json({ error: 'Gagal menyimpan submission ke database cloud.', details: error.message });
    }
  } else {
    const submissions = readSubmissions();
    const newSubmission = {
      id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...payload
    };

    submissions.unshift(newSubmission); // Add newest first
    
    if (writeSubmissions(submissions)) {
      console.log(`[File Submission Success] ${type} from ${name}`);
      res.status(201).json({ 
        message: 'Submission berhasil disimpan!', 
        data: newSubmission 
      });
    } else {
      res.status(500).json({ error: 'Gagal menyimpan submission ke server lokal.' });
    }
  }
});

// 2. Get All Submissions (for teacher view/dashboard)
app.get('/api/submissions', async (req, res) => {
  if (isMongoEnabled) {
    try {
      const subs = await Submission.find().sort({ timestamp: -1 });
      res.json(subs);
    } catch (error) {
      console.error('Error fetching from MongoDB:', error);
      res.status(500).json({ error: 'Gagal memuat data dari database cloud.', details: error.message });
    }
  } else {
    const submissions = readSubmissions();
    res.json(submissions);
  }
});

// 3. Clear All Submissions (optional utility)
app.delete('/api/submissions', async (req, res) => {
  if (isMongoEnabled) {
    try {
      await Submission.deleteMany({});
      res.json({ message: 'Semua data submission di database cloud berhasil dihapus.' });
    } catch (error) {
      console.error('Error deleting from MongoDB:', error);
      res.status(500).json({ error: 'Gagal menghapus data dari database cloud.' });
    }
  } else {
    if (writeSubmissions([])) {
      res.json({ message: 'Semua data submission berhasil dihapus.' });
    } else {
      res.status(500).json({ error: 'Gagal menghapus data submission.' });
    }
  }
});

// 4. Update Submission with Grade and Feedback (for teachers)
app.put('/api/submissions/:id', async (req, res) => {
  const { id } = req.params;
  const { teacherScore, teacherFeedback } = req.body;

  if (isMongoEnabled) {
    try {
      const updatedSub = await Submission.findByIdAndUpdate(
        id,
        { teacherScore, teacherFeedback },
        { new: true }
      );
      if (!updatedSub) {
        return res.status(404).json({ error: 'Data submission tidak ditemukan.' });
      }
      res.json({ message: 'Nilai dan masukan berhasil disimpan!', data: updatedSub });
    } catch (error) {
      console.error('Error updating in MongoDB:', error);
      res.status(500).json({ error: 'Gagal menyimpan nilai ke database cloud.' });
    }
  } else {
    let submissions = readSubmissions();
    // In JSON fallback, 'id' could be a string timestamp or UUID
    const subIdx = submissions.findIndex(s => s.id === id || String(s.timestamp) === id);
    if (subIdx === -1) {
      return res.status(404).json({ error: 'Data submission tidak ditemukan.' });
    }
    
    submissions[subIdx].teacherScore = Number(teacherScore);
    submissions[subIdx].teacherFeedback = teacherFeedback || '';
    
    if (writeSubmissions(submissions)) {
      res.json({ message: 'Nilai dan masukan berhasil disimpan!', data: submissions[subIdx] });
    } else {
      res.status(500).json({ error: 'Gagal menyimpan nilai ke server lokal.' });
    }
  }
});

// Start Server locally if not running on Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
