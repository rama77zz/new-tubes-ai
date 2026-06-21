require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Inisialisasi Groq SDK
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

// Memori penyimpan riwayat obrolan berbasis sesi website agar percakapan nyambung
const chatHistories = new Map();

const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

// Memastikan file knowledge.json awal tersedia
if (!fs.existsSync(knowledgeFile)) {
    fs.writeFileSync(knowledgeFile, JSON.stringify({ keywords: {}, responses: {} }, null, 2));
}

function loadKnowledge() {
    try {
        const data = fs.readFileSync(knowledgeFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading knowledge:', error);
        return { keywords: {}, responses: {} };
    }
}

function saveKnowledge(data) {
    try {
        fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
        ragEngine.clearCache();
        return true;
    } catch (error) {
        console.error('Error saving knowledge:', error);
        return false;
    }
}

function loadBehavior() {
    try {
        if (!fs.existsSync(behaviorFile)) return null;
        const content = fs.readFileSync(behaviorFile, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading behavior config:', error.message);
        return null;
    }
}

function saveBehavior(obj) {
    try {
        fs.mkdirSync(path.dirname(behaviorFile), { recursive: true });
        fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving behavior config:', error.message);
        return false;
    }
}

/**
 * Memproses pesan ke API Groq menggunakan Konteks RAG dan Riwayat Obrolan
 */
async function getAIResponse(message, contextItems = [], behavior = null, userId) {
    try {
        const contextBlock = ragEngine.buildContextBlock(contextItems);
        if (!behavior) {
            behavior = loadBehavior() || {
                system_instructions: 'Jawab berdasarkan konteks.',
                fallback_response: 'Mohon maaf, data tidak ditemukan.',
                max_sentences: 2,
                language: 'id'
            };
        }

        const contextText = contextItems.length > 0 
            ? `\n\nKonteks Dokumen Akademik TUS Resmi:\n${contextBlock}` 
            : `\n\nKonteks Dokumen Akademik TUS: [Tidak ada aturan akademik spesifik yang relevan dengan pertanyaan mahasiswa saat ini]`;

        const systemParts = [];
        if (behavior.system_instructions) systemParts.push(behavior.system_instructions);
        
        systemParts.push(`\nPanduan Ekstra: Jika pertanyaan menanyakan produk atau hal yang tidak ada di Konteks Data Akademik, katakan: "${behavior.fallback_response}"`);
        systemParts.push(`Jawab maksimal ${behavior.max_sentences || 3} kalimat. Bahasa: ${behavior.language || 'id'}.`);
        
        const systemMessage = systemParts.join(' ') + contextText;

        // Ambil riwayat obrolan sebelumnya untuk pengguna web ini
        let history = chatHistories.get(userId) || [];

        // Siapkan array messages untuk Groq
        const messages = [
            { role: 'system', content: systemMessage },
            ...history,
            { role: 'user', content: message }
        ];

        const completion = await groq.chat.completions.create({
            messages: messages,
            model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
            max_tokens: Number(process.env.GROQ_MAX_TOKENS || 200),
            temperature: 0.2
        });

        const aiResponseText = completion.choices[0].message.content;

        // Simpan pesan saat ini ke riwayat obrolan lokal memori
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: aiResponseText });

        // Batasi memori hanya 10 pesan terakhir (5 tanya, 5 jawab) agar tidak bengkak
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
// ENDPOINT UTAMA: Menangani request chat langsung dari Website Frontend
// ====================================================================
app.post('/api/chat', async (req, res) => {
    try {
        const { message, userId } = req.body;
        const activeUserId = userId || 'default-web-user';

        if (!message || message.trim() === "") {
            return res.status(400).json({ error: 'Pesan tidak boleh kosong', success: false });
        }

        console.log(`[Web Message] User (${activeUserId}): ${message}`);

        const knowledge = loadKnowledge();
        
        let pesanMasuk = message.toLowerCase().trim(); 
        let faqResponse = null;

        // 1. GARDA TERDEPAN: Cek Kata Kunci Kaku (knowledge.json)
        if (knowledge.keywords && knowledge.responses) {
            for (const [kunciUtama, daftarKata] of Object.entries(knowledge.keywords)) {
                if (Array.isArray(daftarKata) && daftarKata.some(kata => pesanMasuk.includes(kata))) {
                    faqResponse = knowledge.responses[kunciUtama];
                    break;
                }
            }
        }

        if (faqResponse) {
            console.log(`[Web Chat] Match via knowledge.json`);
            return res.json({ reply: faqResponse, source: 'FAQ Direct Match' });
        }

        // 2. JALUR UTAMA: Ekstraksi Dokumen Menggunakan RAG TF-IDF Lokal
        const allDocuments = datasetManager.getAllDocuments();

        // LAYER 1: KAMUS KOREKSI TYPO & BAHASA GAUL/SANTAI
        const kamusKoreksiMassal = {
            "yidisium": "yudisium",
            "yudisum": "yudisium",
            "yudis": "yudisium",
            "epert": "eprt toefl",
            "tofel": "eprt toefl",
            "bpp": "bpp ukt uang kuliah",
            "ukt": "bpp ukt uang kuliah",
            "sksan": "sks maksimal kuota",
            "krsan": "krs ksm registrasi",
            "ksman": "krs ksm registrasi",
            "doswal": "dosen wali perwalian",
            "skripsian": "skripsi tugas akhir ta",
            "internsip": "kerja praktik magang wrap",
            "cumlaud": "cum laude pujian",
            "comlaude": "cum laude pujian",
            "dropaut": "drop out sp surat peringatan",
            "mangkir": "mangkir tidak aktif nonaktif",
            "semester pendek": "semester antara pendek sp",
            "rapor": "laporan kemajuan studi lks",
            "transkrip": "transkrip akademik nilai",
            "3.5 tahun": "7 semester lulus cepat masa studi normal",
            "3,5 tahun": "7 semester lulus cepat masa studi normal",
            "3 setengah tahun": "7 semester lulus cepat masa studi normal",
            "4 tahun": "8 semester masa studi normal sarjana",
            "3 tahun": "6 semester masa studi normal diploma tiga",
            "7 semester": "7 semester lulus cepat masa studi normal",
            "8 semester": "8 semester masa studi normal sarjana",
            "6 semester": "6 semester masa studi normal diploma tiga",
            "nilai minimal": "nilai huruf terendah lulus minimum",
            "nilai kelulusan": "nilai huruf terendah lulus minimum",
            "ngulang matkul": "nilai d atau e mengulang mata kuliah",
            "perbaikan nilai": "nilai d atau e mengulang mata kuliah"
        };

        // Memanipulasi isi pesanMasuk yang sudah dideklarasikan di atas
        for (const [salah, benar] of Object.entries(kamusKoreksiMassal)) {
            if (pesanMasuk.includes(salah)) {
                pesanMasuk = pesanMasuk.replace(new RegExp(`\\b${salah}\\b|${salah}`, 'g'), benar);
            }
        }

        // LAYER 2: PEMBERSIHAN KATA BASA-BASI / STOPWORDS
        const kataBasaBasi = [
            "bagaimana", "apakah", "gimana", "sih", "dong", "kak", "min", "tolong", 
            "mau", "tanya", "saya", "kamu", "itu", "ini", "yang", "di", "ke", "dari", 
            "bisa", "kah", "bila", "jika", "kalau", "tentang", "mengenai", "untuk",
            "buat", "ikut", "ada", "nanya", "ya", "kok", "nih", "bisa", "syarat",
            "cara", "aturan", "ketentuan", "panduan", "adalah", "apa", "biar", "supaya"
        ];

        let kataKunciInti = pesanMasuk.split(/\s+/)
            .filter(kata => !kataBasaBasi.includes(kata))
            .join(" ");

        // LAYER 3: KAMUS EKSPANSI & SINONIM AKADEMIK MAKSIMAL
        let queryDibersihkan = kataKunciInti;
        const kamusEkspansiMaksimal = {
            "eprt": "eprt toefl ielts kecakapan bahasa inggris skor nilai minimum kelulusan lulus",
            "toefl": "eprt toefl ielts kecakapan bahasa inggris skor nilai minimum kelulusan lulus",
            "tak": "tak transkrip aktivitas kemahasiswaan poin minimal organisasi sertifikat",
            "yudisium": "yudisium dekan sidang penetapan kelulusan ijazah skl fakultas rektor",
            "wisuda": "syarat lulus kelulusan wisuda ukt lunas publikasi ta ijazah transkrip",
            "skripsi": "tugas akhir ta skripsi skripsian sidang proposal pembimbing artikel ilmiah",
            "ta": "tugas akhir ta skripsi skripsian sidang proposal pembimbing artikel ilmiah",
            "kp": "magang kerja praktik kp wrap internship kerja industri",
            "magang": "magang kerja praktik kp wrap internship kerja industri",
            "cuti": "cuti akademik nonaktif bpp status 10 persen tingkat 1 izin pimpinan upps",
            "sks": "beban belajar sks maksimal kuota ip ips ambil krs semester",
            "krs": "krs ksm registrasi daftar ulang ukt ksm cetak awal semester",
            "sp": "semester antara pendek sp remedial kelas perkuliahan memperbaiki nilai 9 sks",
            "do": "drop out sp surat peringatan evaluasi tingkat do spa sanksi akademik",
            "nilai": "skala nilai bobot indeks mutu konversi a ab b bc c d e terendah",
            "lks": "laporan kemajuan studi lks orang tua broadcast nilai evaluasi",
            "fast track": "fast track skema studi percepatan sarjana magister 10 semester ipk 3.25"
        };

        for (const [singkatan, deskripsiPanjang] of Object.entries(kamusEkspansiMaksimal)) {
            if (pesanMasuk.includes(singkatan) || queryDibersihkan.includes(singkatan)) {
                queryDibersihkan = `${queryDibersihkan} ${deskripsiPanjang}`;
            }
        }

        // LAYER 4: PENYELARASAN RIWAYAT CONTEXT (Contextual Chat Awareness)
// =========================================================================
// LAYER 4: PENYELARASAN RIWAYAT CONTEXT (Contextual Chat Awareness) - FIXED
// =========================================================================
let history = chatHistories.get(activeUserId) || [];
if (history.length >= 2) { // Dipastikan minimal ada 1 pasang tanya-jawab (2 pesan)
    const lastUserMsg = history[history.length - 2]?.content || "";
    if (lastUserMsg.trim() !== "") {
        const cleanedLastMsg = lastUserMsg
            .toLowerCase()
            .split(/\s+/)
            .filter(k => !kataBasaBasi.includes(k))
            .join(" ");
            
        // Hanya gabungkan jika pesan sebelumnya memiliki kata kunci inti
        if (cleanedLastMsg.trim() !== "") {
            queryDibersihkan = `${cleanedLastMsg} ${queryDibersihkan}`;
        }
    }
}

        // Cari ke dataset menggunakan mesin RAG baru
        const contextItems = ragEngine.retrieveContext(
            queryDibersihkan,
            allDocuments,
            Number(process.env.RAG_TOP_K || 6)
        );
        
        console.log(`[Web Chat] RAG Final Extracted Query: "${queryDibersihkan}" -> Retrieved ${contextItems.length} context(s)`);
        
        // 3. PROSES CONTEXT DENGAN GROQ LLM
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI response timeout')), 20000)
        );
        
        try {
            const behavior = loadBehavior();
            
            const aiResponse = await Promise.race([
                getAIResponse(message, contextItems, behavior, activeUserId),
                timeoutPromise
            ]);

            if (aiResponse && aiResponse.trim() !== "") {
                return res.json({ reply: aiResponse, source: 'RAG Engine + Groq AI' });
            } else {
                return res.json({ 
                    reply: 'Mohon maaf, saya belum menemukan aturan spesifik mengenai hal tersebut di buku pedoman akademik saat ini. Bisa tolong berikan kata kunci yang lebih jelas?', 
                    source: 'Safe Fallback' 
                });
            }
        } catch (aiError) {
            console.error('AI Processing Error:', aiError.message);
            return res.json({ 
                reply: 'Maaf, sistem AI sedang mengalami antrean komputasi. Silakan coba kirimkan ulang pertanyaan Anda.', 
                source: 'Timeout Fallback' 
            });
        }
    } catch (error) {
        console.error('API Chat Error:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ====================================================================
// ENDPOINT MANAJEMEN DATASET & CONFIG (UNTUK DASHBOARD ADMIN)
// ====================================================================

app.get('/api/datasets', (req, res) => {
    res.json({
        datasets: datasetManager.listDatasets(),
        totalDocuments: datasetManager.getAllDocuments().length
    });
});

app.get('/api/datasets/:name', (req, res) => {
    const docs = datasetManager.getDatasetDocuments(req.params.name);
    if (docs.length === 0) {
        return res.status(404).json({ message: 'Dataset tidak ditemukan' });
    }
    res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!name || !data) {
            return res.status(400).json({ message: 'name dan data harus diisi' });
        }
        const result = datasetManager.saveDataset(name, data);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message });
    }
});

app.get('/api/knowledge/keywords', (req, res) => {
    const knowledge = loadKnowledge();
    res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
    try {
        const { keyword, response } = req.body;
        if (!keyword || !response) {
            return res.status(400).json({ message: 'Keyword dan response harus diisi', success: false });
        }
        const knowledge = loadKnowledge();
        const cleanKey = keyword.toLowerCase().trim();
        
        knowledge.responses[cleanKey] = response;
        
        // Memastikan key terdaftar di array keywords juga agar loop for terdepan bekerja
        if (!knowledge.keywords[cleanKey]) {
            knowledge.keywords[cleanKey] = [cleanKey];
        }

        if (saveKnowledge(knowledge)) {
            res.json({ message: 'Keyword berhasil disimpan', success: true });
        } else {
            res.status(500).json({ message: 'Error menyimpan keyword', success: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message, success: false });
    }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
    try {
        const keyword = decodeURIComponent(req.params.keyword).toLowerCase().trim();
        const knowledge = loadKnowledge();
        
        let deleted = false;
        if (knowledge.responses[keyword]) {
            delete knowledge.responses[keyword];
            deleted = true;
        }
        if (knowledge.keywords[keyword]) {
            delete knowledge.keywords[keyword];
            deleted = true;
        }

        if (deleted) {
            if (saveKnowledge(knowledge)) {
                return res.json({ message: 'Keyword berhasil dihapus', success: true });
            } else {
                return res.status(500).json({ message: 'Error menghapus keyword', success: false });
            }
        } else {
            return res.status(404).json({ message: 'Keyword tidak ditemukan', success: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message, success: false });
    }
});

app.get('/api/behavior', (req, res) => {
    try {
        const behavior = loadBehavior();
        if (!behavior) return res.status(404).json({ message: 'Behavior config not found' });
        res.json(behavior);
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message });
    }
});

app.post('/api/behavior', (req, res) => {
    try {
        const obj = req.body;
        if (!obj || typeof obj !== 'object') {
            return res.status(400).json({ message: 'Invalid behavior object' });
        }
        const saved = saveBehavior(obj);
        if (saved) return res.json({ message: 'Behavior saved', success: true });
        res.status(500).json({ message: 'Error saving behavior', success: false });
    } catch (error) {
        res.status(500).json({ message: 'Error: ' + error.message });
    }
});

// Menjalankan server Express
app.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);
});