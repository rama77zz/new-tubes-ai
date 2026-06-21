const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

class DatasetManager {
    constructor() {
        // Mengarah langsung ke file dataset di dalam folder data
        this.csvFilePath = path.join(__dirname, '../data/Dataset_Pedoman_Akademik_Telkom_2024.csv');
    }

    /**
     * Membaca file CSV mentah berdasarkan struktur kolom (content, kategori, topik)
     * @returns {Array} List data berisi objek { pageContent, metadata }
     */
    getAllDocuments() {
        try {
            if (!fs.existsSync(this.csvFilePath)) {
                console.error(`[Dataset Error] File tidak ditemukan di: ${this.csvFilePath}`);
                return [];
            }

            // 1. Baca berkas CSV
            const workbook = xlsx.readFile(this.csvFilePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            // 2. Konversi worksheet menjadi JSON Array
            const rawData = xlsx.utils.sheet_to_json(worksheet);
            const formattedDocs = [];

            // 3. Iterasi setiap baris pedoman akademik
            rawData.forEach((row, index) => {
                // Mendukung variasi huruf kapital pada kolom CSV
                const mainText = row.content || row.Content || row.Text || row.text || "";
                const currentTopic = row.topik || row.Topik || row.Page || row.page || `Aturan-${index}`;
                const currentCategory = row.kategori || row.Kategori || "Akademik Umum";

                if (!mainText.trim()) return;

                // Membersihkan spasi berlebih dan carriage return (\r)
                const cleanText = mainText.replace(/\r/g, '').replace(/\s+/g, ' ').trim();

                // Potong manual per 800 karakter jika terlalu panjang
                const maxChunkSize = 800;
                let start = 0;

                while (start < cleanText.length) {
                    let end = start + maxChunkSize;
                    
                    // Cek spasi agar kata tidak terputus di tengah (Aman dari infinite loop)
                    if (end < cleanText.length) {
                        const currentChunkSnippet = cleanText.slice(start, end);
                        const lastSpaceInChunk = currentChunkSnippet.lastIndexOf(' ');
                        
                        if (lastSpaceInChunk > 200) {
                            end = start + lastSpaceInChunk;
                        }
                    }

                    const chunkText = cleanText.slice(start, end).trim();

                    if (chunkText.length > 20) {
                        // Kategorisasi Otomatis Cadangan jika kategori bawaan masih default/umum
                        let kategori = currentCategory;
                        if (kategori === "Umum" || kategori === "Akademik Umum") {
                            const textLower = chunkText.toLowerCase();
                            if (anyIncluded(textLower, ["cuti", "registrasi", "nonaktif", "undur", "pindah", "kartu", "perwalian", "krs", "ksm"])) {
                                kategori = "Administrasi & Layanan";
                            } else if (anyIncluded(textLower, ["lulus", "yudisium", "gelar", "ijazah", "skpi", "predikat"])) {
                                kategori = "Kelulusan & Tugas Akhir";
                            } else if (anyIncluded(textLower, ["nilai", "evaluasi", "sks", "indeks", "prestasi", "standar penilaian"])) {
                                kategori = "Evaluasi & Penilaian";
                            } else if (anyIncluded(textLower, ["magang", "rpl", "fast track", "internasional", "pjj", "jarak jauh", "wrap"])) {
                                kategori = "Program Khusus";
                            }
                        }

                        // Masukkan ke format penampung dokumen yang siap dibaca RAGEngine
                        formattedDocs.push({
                            pageContent: chunkText,
                            metadata: {
                                id: `row-${index}-chunk-${start}`,
                                kategori: kategori,
                                topik: currentTopic.toString().startsWith("Halaman") ? currentTopic : `Topik: ${currentTopic}`,
                                sumber: "Pedoman Akademik TUS 2024"
                            }
                        });
                    }
                    start = end + 1;
                }
            });

            return formattedDocs;
        } catch (error) {
            console.error('Error saat mengekstrak dataset CSV mentah:', error.message);
            return [];
        }
    }

    listDatasets() {
        try {
            if (fs.existsSync(this.csvFilePath)) {
                return [path.basename(this.csvFilePath)];
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Mengambil dokumen spesifik berdasarkan nama dataset (Dibutuhkan oleh server-v2.js)
     */
    getDatasetDocuments(name) {
        const targetPath = path.join(__dirname, '../data', name);
        if (fs.existsSync(targetPath)) {
            // Karena manajemen internal Anda menggunakan getAllDocuments, kita panggil langsung jika file cocok
            return this.getAllDocuments();
        }
        return [];
    }

    /**
     * Menyimpan atau memperbarui data dataset (Dibutuhkan oleh server-v2.js)
     */
    saveDataset(name, data) {
        try {
            const targetPath = path.join(__dirname, '../data', name);
            // Memastikan folder data sudah terbentuk
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            
            // Konversi data array/objek kembali ke worksheet xlsx/csv
            const worksheet = xlsx.utils.json_to_sheet(data);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, 'Dataset');
            
            xlsx.writeFile(workbook, targetPath);
            return { message: 'Dataset berhasil disimpan', success: true };
        } catch (error) {
            throw new Error('Gagal menyimpan dataset: ' + error.message);
        }
    }
}

// Fungsi pembantu untuk mencocokkan kata kunci kategori
function anyIncluded(targetText, keywordsArray) {
    return keywordsArray.some(word => targetText.includes(word));
}

module.exports = DatasetManager;