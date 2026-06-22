require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const Groq = require('groq-sdk');
const multer = require('multer');
const { put } = require('@vercel/blob');

// ====================================================================
// VERCEL SERVERLESS FIX: Lazy-load modul berat agar tidak crash saat cold start
// ====================================================================
let RAGEngine, DatasetManager;
try {
    RAGEngine = require('./lib/rag');
    DatasetManager = require('./lib/dataset');
} catch (e) {
    console.error("Gagal load modul lib:", e.message);
}

const app = express();

// Middleware Setup
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// ====================================================================
// CONFIG UPLOAD: MENGGUNAKAN MEMORY STORAGE (WAJIB DI VERCEL)
// ====================================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 4.5 * 1024 * 1024 // Batas payload Serverless Vercel (4.5 MB)
    },
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.pdf' && ext !== '.csv') {
            return cb(new Error('Hanya diperbolehkan mengunggah berkas berformat .pdf atau .csv'));
        }
        cb(null, true);
    }
});

// Inisialisasi Groq SDK
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "dummy_key"
});

// Inisialisasi engine RAG dan Dataset
let ragEngine = null;
let datasetManager = null;

try {
    if (RAGEngine) ragEngine = new RAGEngine();
} catch (e) {
    console.error("Gagal inisialisasi RAGEngine:", e.message);
}

try {
    if (DatasetManager) datasetManager = new DatasetManager();
} catch (e) {
    console.error("Gagal inisialisasi DatasetManager:", e.message);
}

// ====================================================================
// VERCEL FIX: Knowledge store in-memory (filesystem Vercel read-only)
// Jika butuh persistence, pindahkan ke Vercel KV / database eksternal
// ====================================================================
let inMemoryKnowledge = { keywords: {}, responses: {} };

// Coba baca knowledge.json dari bundle (read-only, hanya saat deploy pertama)
try {
    const fs = require('fs');
    const knowledgeFile = path.join(__dirname, 'knowledge.json');
    if (fs.existsSync(knowledgeFile)) {
        const data = fs.readFileSync(knowledgeFile, 'utf8');
        inMemoryKnowledge = JSON.parse(data);
        console.log('[Knowledge] Berhasil memuat knowledge.json dari bundle deploy.');
    }
} catch (e) {
    console.warn('[Knowledge] knowledge.json tidak ditemukan, menggunakan store kosong.');
}

function loadKnowledge() {
    return inMemoryKnowledge;
}

function saveKnowledge(data) {
    try {
        inMemoryKnowledge = data;
        if (ragEngine && typeof ragEngine.clearCache === 'function') ragEngine.clearCache();
        return true;
    } catch (error) {
        console.error('Error saving knowledge (in-memory):', error);
        return false;
    }
}

// ====================================================================
// Chat history in-memory (akan reset pada setiap cold start Vercel)
// ====================================================================
const chatHistories = new Map();

/**
 * Memproses pesan ke API Groq menggunakan Konteks RAG dan Riwayat Obrolan
 */
async function getAIResponse(message, contextItems = [], behavior = null, userId) {
    try {
        if (!ragEngine) throw new Error("RAGEngine tidak terinisialisasi");

        const contextBlock = ragEngine.buildContextBlock(contextItems);
        if (!behavior) {
            behavior = {
                system_instructions: 'Jawab berdasarkan konteks aturan akademik SSC TUS secara formal dan solutif.',
                fallback_response: 'Mohon maaf, data tersebut tidak ditemukan dalam dokumen pedoman akademik resmi kami.',
                max_sentences: 3,
                language: 'id'
            };
        }

        const contextText = contextItems.length > 0
            ? `\n\nKonteks Dokumen Akademik TUS Resmi:\n${contextBlock}`
            : `\n\nKonteks Dokumen Akademik TUS: [Tidak ada aturan akademik spesifik yang relevan dengan pertanyaan mahasiswa saat ini]`;

        const systemParts = [
            behavior.system_instructions,
            `\nPanduan Ekstra: Jika pertanyaan menanyakan hal di luar regulasi akademik atau tidak tercantum di Konteks Data Akademik, katakan: "${behavior.fallback_response}"`,
            `Jawab maksimal ${behavior.max_sentences || 3} kalimat. Bahasa: ${behavior.language || 'id'}.`
        ];

        const systemMessage = systemParts.join(' ') + contextText;
        let history = chatHistories.get(userId) || [];

        const messages = [
            { role: 'system', content: systemMessage },
            ...history,
            { role: 'user', content: message }
        ];

        const completion = await groq.chat.completions.create({
            messages: messages,
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            max_tokens: Number(process.env.GROQ_MAX_TOKENS || 250),
            temperature: 0.2
        });

        const aiResponseText = completion.choices[0].message.content;

        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: aiResponseText });

        if (history.length > 10) {
            history = history.slice(history.length - 10);
        }

        chatHistories.set(userId, history);
        return aiResponseText;
    } catch (error) {
        console.error('Error getting AI response:', error.message);
        return null;
    }
}

// ====================================================================
// ENDPOINT 1: PROSES UTAMA CORE CHATBOT ASSISTANT
// ====================================================================
app.post('/api/chat', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
        const { message, userId } = req.body;
        const activeUserId = userId || 'default-web-user';

        if (!message || message.trim() === "") {
            return res.status(400).json({ error: 'Pesan tidak boleh kosong', success: false });
        }

        console.log(`[Web Message] User (${activeUserId}): ${message}`);

        // Jalur Cepat 1: Cek FAQ Direct Match dari knowledge store
        const knowledge = loadKnowledge();
        let pesanMasuk = message.toLowerCase().trim();
        let faqResponse = null;

        if (knowledge.keywords && knowledge.responses) {
            const potonganKataUser = pesanMasuk.split(/\s+/);
            for (const [kunciUtama, daftarKata] of Object.entries(knowledge.keywords)) {
                if (Array.isArray(daftarKata)) {
                    const adaMencocok = daftarKata.some(kataDariJson => {
                        if (kataDariJson.includes(" ")) {
                            return pesanMasuk.includes(kataDariJson);
                        }
                        return potonganKataUser.includes(kataDariJson);
                    });

                    if (adaMencocok) {
                        faqResponse = knowledge.responses[kunciUtama];
                        break;
                    }
                }
            }
        }

        if (faqResponse) {
            return res.json({ reply: faqResponse, source: 'FAQ Direct Match' });
        }

        // Jalur RAG
        if (!datasetManager) {
            return res.json({ reply: 'Sistem database RAG belum terinisialisasi sempurna.', source: 'Error Fallback' });
        }

        const allDocuments = await datasetManager.getAllDocuments().catch(() => []);

        // Algoritma Penyelaras Kata (Koreksi Massal Typo)
        const kamusKoreksiMassal = {
            "yidisium": "yudisium", "yudisum": "yudisium", "yudis": "yudisium",
            "epert": "eprt toefl", "tofel": "eprt toefl", "bpp": "bpp ukt uang kuliah",
            "ukt": "bpp ukt uang kuliah", "sksan": "sks maksimal kuota",
            "krsan": "krs ksm registrasi", "ksman": "krs ksm registrasi",
            "doswal": "dosen wali perwalian", "skripsian": "skripsi tugas akhir ta",
            "internsip": "kerja praktik magang wrap", "cumlaud": "cum laude pujian",
            "comlaude": "cum laude pujian", "dropaut": "drop out sp surat peringatan",
            "mangkir": "mangkir tidak aktif nonaktif", "semester pendek": "semester antara pendek sp",
            "transkrip": "transkrip akademik nilai", "nilai minimal": "nilai huruf terendah lulus minimum"
        };

        for (const [salah, benar] of Object.entries(kamusKoreksiMassal)) {
            if (pesanMasuk.includes(salah)) {
                pesanMasuk = pesanMasuk.replace(new RegExp(`\\b${salah}\\b|${salah}`, 'g'), benar);
            }
        }

        // Ekspansi Kueri Otomatis
        let queryDibersihkan = pesanMasuk;
        const kamusEkspansiMaksimal = {
            "eprt": "eprt toefl kecakapan bahasa inggris skor nilai minimum kelulusan lulus",
            "tak": "tak transkrip aktivitas kemahasiswaan poin organisasi sertifikat",
            "yudisium": "yudisium dekan sidang penetapan kelulusan ijazah skl fakultas",
            "wisuda": "syarat lulus kelulusan wisuda ukt lunas ta ijazah",
            "skripsi": "tugas akhir ta skripsi sidang proposal pembimbing",
            "ta": "tugas akhir ta skripsi sidang proposal pembimbing",
            "magang": "magang kerja praktik kp wrap internship",
            "cuti": "cuti akademik nonaktif status izin pimpinan",
            "sks": "beban belajar sks maksimal kuota krs semester",
            "krs": "krs ksm registrasi daftar ulang ukt ksm",
            "sp": "semester antara pendek sp remedial kelas memperbaiki nilai",
            "do": "drop out sp surat peringatan evaluation sanksi akademik"
        };

        for (const [singkatan, deskripsiPanjang] of Object.entries(kamusEkspansiMaksimal)) {
            if (pesanMasuk.includes(singkatan)) {
                queryDibersihkan = `${queryDibersihkan} ${deskripsiPanjang}`;
            }
        }

        const contextItems = ragEngine ? ragEngine.retrieveContext(
            queryDibersihkan.replace(/\s+/g, ' ').trim(),
            allDocuments,
            Number(process.env.RAG_TOP_K || 6)
        ) : [];

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI response timeout')), 9000) // 9 detik agar tidak melebihi maxDuration 10 detik Vercel
        );

        const aiResponse = await Promise.race([
            getAIResponse(message, contextItems, null, activeUserId),
            timeoutPromise
        ]);

        if (aiResponse && aiResponse.trim() !== "") {
            return res.json({ reply: aiResponse, source: 'RAG Engine + Groq AI' });
        } else {
            return res.json({
                reply: 'Mohon maaf, saya belum menemukan regulasi spesifik mengenai hal tersebut di basis data akademik. Coba gunakan kata kunci yang lain.',
                source: 'Safe Fallback'
            });
        }
    } catch (error) {
        console.error('API Chat Error:', error.message);
        return res.json({
            reply: 'Maaf, asisten cerdas sedang mengalami gangguan komunikasi. Silakan kirimkan ulang pesan Anda.',
            source: 'Global Exception Fallback'
        });
    }
});

// ====================================================================
// ENDPOINT 2: AMBIL DAFTAR DATASET KNOWLEDGE BASE
// ====================================================================
app.get('/api/datasets', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
        if (!datasetManager) {
            return res.json({ datasets: [], totalDocuments: 0, error: "Manager tidak aktif" });
        }

        const allDocs = await datasetManager.getAllDocuments().catch(() => []);
        const datasetsList = await datasetManager.listDatasets().catch(() => []);

        return res.json({
            datasets: Array.isArray(datasetsList) ? datasetsList : [],
            totalDocuments: Array.isArray(allDocs) ? allDocs.length : 0
        });
    } catch (error) {
        console.error('API Get Datasets Crash Handled:', error.message);
        return res.json({
            datasets: [],
            totalDocuments: 0,
            error: true,
            message: error.message
        });
    }
});

// ====================================================================
// ENDPOINT 3: UNGGAH FILE AKADEMIK BARU KE VERCEL BLOB STORAGE
// ====================================================================
app.post('/api/datasets/upload', upload.single('document'), async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file dokumen yang dipilih.' });
        }

        const tokenBlob = process.env.BLOB_READ_WRITE_TOKEN;
        if (!tokenBlob) {
            return res.status(500).json({ success: false, message: 'Token BLOB_READ_WRITE_TOKEN belum dipasang di environment Vercel.' });
        }

        const cleanName = req.file.originalname.replace(/\s+/g, '_');

        const blob = await put(`datasets/${cleanName}`, req.file.buffer, {
            access: 'public',
            token: tokenBlob
        });

        console.log(`[Cloud Storage] Berhasil mengunggah berkas ke: ${blob.url}`);

        return res.json({
            success: true,
            message: `Berkas ${cleanName} sukses disinkronkan ke Cloud Storage!`,
            url: blob.url
        });
    } catch (error) {
        console.error('Error Cloud Upload:', error.message);
        return res.status(500).json({ success: false, message: 'Gagal mengunggah ke cloud: ' + error.message });
    }
});

// ====================================================================
// VERCEL FIX: Export handler, BUKAN app.listen()
// app.listen() menyebabkan crash di serverless environment Vercel
// ====================================================================
module.exports = app;