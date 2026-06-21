class RAGEngine {
    constructor() {
        // Cache untuk menghindari kalkulasi berulang jika dokumen tidak berubah
        this.cache = null;
    }

    /**
     * Membersihkan cache internal mesin RAG (Dipanggil saat knowledge dasar diubah)
     */
    clearCache() {
        this.cache = null;
    }

    /**
     * Mencari potongan dokumen (chunks) yang paling relevan dengan kueri pengguna
     * Menggunakan pendekatan pencocokan kata kunci berbasis skor sederhana (TF-like)
     * @param {string} query Kueri pencarian yang sudah dibersihkan dan diekspansi
     * @param {Array} documents Array berisi seluruh dokumen hasil DatasetManager
     * @param {number} topK Jumlah maksimal dokumen relevan yang ingin diambil
     * @returns {Array} List dokumen terpilih yang paling relevan
     */
    retrieveContext(query, documents, topK = 6) {
        if (!query || !documents || documents.length === 0) return [];

        const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 1);
        if (queryWords.length === 0) return [];

        // Hitung skor kecocokan untuk setiap dokumen chunk
        const scoredDocs = documents.map(doc => {
            const contentLower = doc.pageContent.toLowerCase();
            const topicLower = (doc.metadata.topik || "").toLowerCase();
            const categoryLower = (doc.metadata.kategori || "").toLowerCase();
            
            let score = 0;

            queryWords.forEach(word => {
                // Bobot lebih tinggi jika kata kunci cocok dengan judul Topik/Kategori
                if (topicLower.includes(word)) score += 3.0;
                if (categoryLower.includes(word)) score += 2.0;
                
                // Bobot berbasis frekuensi kata di dalam isi konten (Term Frequency sederhana)
                const regex = new RegExp(this.escapeRegExp(word), 'g');
                const matches = contentLower.match(regex);
                if (matches) {
                    score += matches.length * 1.0;
                }
            });

            return { doc, score };
        });

        // Filter dokumen yang memiliki skor > 0, urutkan dari yang tertinggi, lalu ambil sebanyak topK
        return scoredDocs
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(item => item.doc);
    }

    /**
     * Menggabungkan potongan teks dokumen menjadi satu blok teks utuh untuk Konteks LLM
     * @param {Array} contextItems List dokumen hasil dari retrieveContext
     * @returns {string} String blok konteks terformat
     */
    buildContextBlock(contextItems) {
        if (!contextItems || contextItems.length === 0) {
            return "[Tidak ada aturan akademik spesifik yang relevan dengan pertanyaan mahasiswa saat ini]";
        }

        return contextItems.map((item, idx) => {
            return `--- DOKUMEN RELEVAN ${idx + 1} ---
[Kategori: ${item.metadata.kategori}]
[Topik: ${item.metadata.topik}]
[Sumber: ${item.metadata.sumber}]
Isi Aturan: ${item.pageContent}`;
        }).join("\n\n");
    }

    /**
     * Fungsi pembantu untuk mengamankan karakter regex
     */
    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

module.exports = RAGEngine;