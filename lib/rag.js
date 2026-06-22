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
     * Dioptimalkan untuk mendeteksi konteks berdekatan pada file PDF dan CSV
     * @param {string} query Kueri pencarian yang sudah dibersihkan dan diekspansi
     * @param {Array} documents Array berisi seluruh dokumen hasil DatasetManager
     * @param {number} topK Jumlah maksimal dokumen relevan yang ingin diambil
     * @returns {Array} List dokumen terpilih yang paling relevan
     */
    retrieveContext(query, documents, topK = 6) {
        if (!query || !documents || documents.length === 0) return [];

        const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 1);
        if (queryWords.length === 0) return [];

        // Ikat fungsi escapeRegExp ke variabel lokal agar aman dipanggil di dalam loop forEach
        const escapeRegexFunc = this.escapeRegExp;

        // Hitung skor kecocokan untuk setiap dokumen chunk
        const scoredDocs = documents.map(doc => {
            const contentLower = doc.pageContent.toLowerCase();
            const topicLower = (doc.metadata.topik || "").toLowerCase();
            const categoryLower = (doc.metadata.kategori || "").toLowerCase();
            const sumberLower = (doc.metadata.sumber || "").toLowerCase();
            
            let score = 0;
            let matchedWordsCount = 0;
            let firstMatchIndex = -1;
            let lastMatchIndex = -1;

            queryWords.forEach(word => {
                let wordMatched = false;

                // 1. BONUS JUDUL TOPIK & KATEGORI (Sangat krusial untuk struktur CSV & PDF)
                if (topicLower.includes(word)) {
                    score += 4.0;
                    wordMatched = true;
                }
                if (categoryLower.includes(word)) {
                    score += 2.0;
                    wordMatched = true;
                }

                // 2. FREKUENSI KATA DI DALAM ISI KONTEN (Term Frequency)
                try {
                    const escapedWord = escapeRegexFunc(word);
                    const regex = new RegExp(escapedWord, 'g');
                    const matches = contentLower.match(regex);
                    
                    if (matches) {
                        score += matches.length * 1.2;
                        wordMatched = true;

                        // Catat posisi indeks untuk kalkulasi kedekatan jarak kata (Density)
                        const pos = contentLower.indexOf(word);
                        if (firstMatchIndex === -1 || pos < firstMatchIndex) firstMatchIndex = pos;
                        if (pos > lastMatchIndex) lastMatchIndex = pos;
                    }
                } catch (e) {
                    // Fallback aman jika regex bermasalah, gunakan penanganan berbasis text string biasa
                    if (contentLower.includes(word)) {
                        score += 1.2;
                        wordMatched = true;
                        const pos = contentLower.indexOf(word);
                        if (firstMatchIndex === -1 || pos < firstMatchIndex) firstMatchIndex = pos;
                        if (pos > lastMatchIndex) lastMatchIndex = pos;
                    }
                }

                if (wordMatched) {
                    matchedWordsCount++;
                }
            });

            // 3. OPTIMALISASI PDF: Bonus Kedekatan Frasa (Proximity/Density Score)
            if (matchedWordsCount > 1) {
                score += matchedWordsCount * 2.0; // Bonus kecocokan multi-kata

                // Semakin dekat jarak antara kata kunci pertama dan terakhir di dalam teks, semakin besar bonusnya
                const matchSpan = lastMatchIndex - firstMatchIndex;
                if (matchSpan > 0 && matchSpan < 300) {
                    score += 3.0; // Bonus teks padat berdekatan
                }
            }

            // 4. BONUS SUMBER (Memberikan sedikit bobot pada nama file)
            queryWords.forEach(word => {
                if (sumberLower.includes(word)) score += 0.5;
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
     * Fungsi pembantu untuk mengamankan karakter regex (Perbaikan Typo Y ke ?)
     */
    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

module.exports = RAGEngine;