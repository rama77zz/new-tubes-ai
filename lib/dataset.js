const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const { list } = require('@vercel/blob');

class DatasetManager {
    constructor() {
        // Token dibaca langsung dari environment variable yang disediakan oleh Vercel
        this.blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    }

    /**
     * Membaca seluruh file CSV dan PDF secara dinamis dari Vercel Blob Storage
     * @returns {Promise<Array>} List data berisi objek { pageContent, metadata }
     */
    async getAllDocuments() {
        const formattedDocs = [];

        try {
            if (!this.blobToken) {
                console.warn('[Dataset Warning] BLOB_READ_WRITE_TOKEN tidak ditemukan. Pastikan storage sudah di-link di Vercel.');
                return [];
            }

            // 1. Ambil seluruh daftar file di cloud storage yang berada dalam folder 'datasets/'
            const { blobs } = await list({
                prefix: 'datasets/',
                token: this.blobToken
            });

            for (const blob of blobs) {
                const fileUrl = blob.url;
                const fileName = blob.pathname.replace('datasets/', '');
                const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

                // 2. Unduh file dalam bentuk Buffer biner dari URL Cloud Vercel
                const response = await fetch(fileUrl);
                if (!response.ok) {
                    console.error(`[Dataset Cloud Error] Gagal mengunduh berkas ${fileName}: ${response.statusText}`);
                    continue;
                }
                
                const arrayBuffer = await response.arrayBuffer();
                const fileBuffer = Buffer.from(arrayBuffer);

                // =========================================================================
                // JALUR 1: PROSES PEMBACAAN FILE CSV DARI CLOUD
                // =========================================================================
                if (ext === '.csv') {
                    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                    const sheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[sheetName];
                    const rawData = xlsx.utils.sheet_to_json(worksheet);

                    rawData.forEach((row, index) => {
                        const mainText = row.content || row.Content || row.Text || row.text || "";
                        const currentTopic = row.topik || row.Topik || row.Page || row.page || `Aturan-${index}`;
                        const currentCategory = row.kategori || row.Kategori || "Akademik Umum";

                        if (!mainText.trim()) return;

                        const cleanText = mainText.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
                        this.chunkAndPush(cleanText, formattedDocs, fileName, currentTopic, currentCategory, index);
                    });
                } 
                // =========================================================================
                // JALUR 2: PROSES PEMBACAAN FILE PDF DARI CLOUD
                // =========================================================================
                else if (ext === '.pdf') {
                    try {
                        const pdfData = await pdfParse(fileBuffer);
                        
                        // Membersihkan teks hasil ekstraksi PDF cloud dari enter berlebih
                        const cleanText = pdfData.text.replace(/\r/g, '').replace(/\s+/g, ' ').trim();

                        if (cleanText.length > 20) {
                            // Menjadikan nama file PDF (tanpa ekstensi) sebagai Judul Topik RAG
                            const topicName = fileName.replace('.pdf', '').replace(/_/g, ' ');
                            this.chunkAndPush(cleanText, formattedDocs, fileName, topicName, "Pedoman Dokumen PDF", 0);
                        }
                    } catch (pdfErr) {
                        console.error(`[Dataset PDF Error] Gagal mengekstrak berkas cloud ${fileName}:`, pdfErr.message);
                    }
                }
            }

            return formattedDocs;
        } catch (error) {
            console.error('Error saat mengekstrak seluruh isi dataset cloud:', error.message);
            return formattedDocs;
        }
    }

    /**
     * Memotong teks panjang (chunking) secara aman berdasarkan batas spasi kata
     */
    chunkAndPush(text, outputArray, fileName, topic, category, rowIndex) {
        const maxChunkSize = 800;
        let start = 0;

        while (start < text.length) {
            let end = start + maxChunkSize;
            
            if (end < text.length) {
                const currentChunkSnippet = text.slice(start, end);
                const lastSpaceInChunk = currentChunkSnippet.lastIndexOf(' ');
                
                if (lastSpaceInChunk > 200) {
                    end = start + lastSpaceInChunk;
                }
            }

            const chunkText = text.slice(start, end).trim();

            if (chunkText.length > 20) {
                let finalCategory = category;
                if (finalCategory === "Umum" || finalCategory === "Akademik Umum" || finalCategory === "Pedoman Dokumen PDF") {
                    const textLower = chunkText.toLowerCase();
                    if (anyIncluded(textLower, ["cuti", "registrasi", "nonaktif", "undur", "pindah", "kartu", "perwalian", "krs", "ksm"])) {
                        finalCategory = "Administrasi & Layanan";
                    } else if (anyIncluded(textLower, ["lulus", "yudisium", "gelar", "ijazah", "skpi", "predikat"])) {
                        finalCategory = "Kelulusan & Tugas Akhir";
                    } else if (anyIncluded(textLower, ["nilai", "evaluasi", "sks", "indeks", "prestasi", "standar penilaian"])) {
                        finalCategory = "Evaluasi & Penilaian";
                    } else if (anyIncluded(textLower, ["magang", "rpl", "fast track", "internasional", "pjj", "jarak jauh", "wrap"])) {
                        finalCategory = "Program Khusus";
                    }
                }

                outputArray.push({
                    pageContent: chunkText,
                    metadata: {
                        id: `${fileName}-row-${rowIndex}-chunk-${start}`,
                        kategori: finalCategory,
                        topik: topic.toString().startsWith("Halaman") ? topic : `Topik: ${topic}`,
                        sumber: fileName
                    }
                });
            }
            start = end + 1;
        }
    }

    /**
     * Mengambil daftar nama file yang tersimpan di dalam cloud Vercel Blob
     */
    async listDatasets() {
        try {
            if (!this.blobToken) return [];
            const { blobs } = await list({
                prefix: 'datasets/',
                token: this.blobToken
            });
            return blobs.map(blob => blob.pathname.replace('datasets/', ''));
        } catch (error) {
            console.error('Error saat listing dataset cloud:', error.message);
            return [];
        }
    }

    /**
     * Mengambil dokumen spesifik (Disesuaikan mengarah ke getAllDocuments berbasis cloud)
     */
    async getDatasetDocuments(name) {
        if (!this.blobToken) return [];
        return await this.getAllDocuments();
    }

    /**
     * Mengosongkan fungsi local write agar tidak menghasilkan crash disk pada Serverless Vercel
     */
    saveDataset(name, data) {
        return { message: 'Fungsi ini dialihkan melalui endpoint cloud upload.', success: true };
    }
}

function anyIncluded(targetText, keywordsArray) {
    return keywordsArray.some(word => targetText.includes(word));
}

module.exports = DatasetManager;