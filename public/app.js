const API_URL = '/api';

function showNotification(message, type = 'info', duration = 3000) {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    document.querySelectorAll('.tab-pane').forEach(c => c.classList.remove('active'));
    document.getElementById(tab).classList.add('active');
    
    if (tab === 'knowledge') {
        loadKeywords();
    } else if (tab === 'datasets') {
        loadDatasetInfo();
    }
}

async function checkBotStatus() {
    try {
        const response = await fetch(`${API_URL}/bot/status`);
        const data = await response.json();
        
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        const qrSection = document.getElementById('qrSection');
        const readySection = document.getElementById('readySection');
        
        if (data.isReady) {
            statusDot.className = 'status-dot active';
            statusText.textContent = 'Bot Terhubung (Online)';
            startBtn.style.display = 'none';
            stopBtn.style.display = 'inline-block';
            qrSection.style.display = 'none';
            readySection.style.display = 'block';
        } else if (data.hasQRCode) {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Menunggu Scan QR';
            startBtn.style.display = 'none';
            stopBtn.style.display = 'inline-block';
            qrSection.style.display = 'block';
            readySection.style.display = 'none';
            loadQRCode();
        } else if (data.isInitializing) {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Menginisialisasi Node...';
            startBtn.style.display = 'none';
            stopBtn.style.display = 'none';
            qrSection.style.display = 'none';
            readySection.style.display = 'none';
        } else {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Bot Offline';
            startBtn.style.display = 'inline-block';
            stopBtn.style.display = 'none';
            qrSection.style.display = 'none';
            readySection.style.display = 'none';
        }
    } catch (error) {
        console.error('Error checking status:', error);
    }
}

async function loadQRCode() {
    try {
        const response = await fetch(`${API_URL}/bot/qr`);
        const data = await response.json();
        
        if (data.qr) {
            const qrContainer = document.getElementById('qrcode');
            qrContainer.innerHTML = '';
            const qrImage = document.createElement('img');
            qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.qr)}`;
            qrImage.style.width = '280px';
            qrImage.style.height = '280px';
            qrContainer.appendChild(qrImage);
        }
    } catch (error) {
        console.error('Error loading QR:', error);
    }
}

document.getElementById('startBtn').addEventListener('click', async () => {
    try {
        const response = await fetch(`${API_URL}/bot/start`, { method: 'POST' });
        const data = await response.json();
        showNotification(data.message, 'success');
        checkBotStatus();
        const interval = setInterval(checkBotStatus, 2000);
        setTimeout(() => clearInterval(interval), 120000);
    } catch (error) {
        showNotification('Error: ' + error.message, 'error');
    }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
    try {
        document.getElementById('stopBtn').disabled = true;
        const response = await fetch(`${API_URL}/bot/stop`, { method: 'POST' });
        const data = await response.json();
        showNotification(data.message, 'success');
        
        document.getElementById('statusDot').className = 'status-dot';
        document.getElementById('statusText').textContent = 'Bot Offline';
        document.getElementById('qrSection').style.display = 'none';
        document.getElementById('readySection').style.display = 'none';
        document.getElementById('startBtn').style.display = 'inline-block';
        document.getElementById('stopBtn').style.display = 'none';
        document.getElementById('stopBtn').disabled = false;
    } catch (error) {
        showNotification('Error: ' + error.message, 'error');
        document.getElementById('stopBtn').disabled = false;
    }
});

async function loadKeywords() {
    try {
        const response = await fetch(`${API_URL}/knowledge/keywords`);
        const data = await response.json();
        const container = document.getElementById('keywordItems');
        container.innerHTML = '';
        
        if (!data.responses || Object.keys(data.responses).length === 0) {
            container.innerHTML = '<p style="color: #999; text-align: center; padding: 40px;">Belum ada klaster kata kunci akademik. Tambahkan baru di atas!</p>';
            return;
        }
        
        Object.entries(data.responses).forEach(([intentName, textResponse]) => {
            const item = document.createElement('div');
            item.className = 'keyword-item';
            
            // Ambil daftar kata kunci pendukung jika ada di map keywords
            const kataKunciTerkait = data.keywords && data.keywords[intentName] 
                ? data.keywords[intentName].join(', ') 
                : intentName;

            item.innerHTML = `
                <div class="keyword-info">
                    <strong>Klaster Pencocokan: (${intentName})</strong>
                    <p style="font-size:12px; color:var(--primary); margin-bottom:6px;">Kata pemicu: ${kataKunciTerkait}</p>
                    <p>${textResponse}</p>
                </div>
                <div class="keyword-actions">
                    <button class="btn" style="background:#e4e7eb;" onclick="editKeyword('${intentName}')">Edit</button>
                    <button class="btn btn-danger" onclick="deleteKeyword('${intentName}')">Hapus</button>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading keywords:', error);
    }
}

async function saveKeyword() {
    const keyword = document.getElementById('keyword').value.trim().toLowerCase();
    const response = document.getElementById('response').value.trim();
    
    if (!keyword || !response) {
        showNotification('Nama klaster pemicu dan jawaban harus diisi!', 'warning');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/knowledge/keyword`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, response })
        });
        const data = await res.json();
        showNotification(data.message, data.success ? 'success' : 'error');
        
        if (data.success) {
            clearForm();
            loadKeywords();
        }
    } catch (error) {
        showNotification('Error: ' + error.message, 'error');
    }
}

function editKeyword(keyword) {
    document.getElementById('keyword').value = keyword;
    loadKeywordsForEdit(keyword);
    document.getElementById('keyword').focus();
}

async function loadKeywordsForEdit(keyword) {
    try {
        const response = await fetch(`${API_URL}/knowledge/keywords`);
        const data = await response.json();
        if (data.responses[keyword]) {
            document.getElementById('response').value = data.responses[keyword];
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function deleteKeyword(keyword) {
    if (!confirm(`Hapus klaster kata kunci "${keyword}"?`)) return;
    try {
        const response = await fetch(`${API_URL}/knowledge/keyword/${encodeURIComponent(keyword)}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        showNotification(data.message, data.success ? 'success' : 'error');
        if (data.success) {
            loadKeywords();
        }
    } catch (error) {
        showNotification('Error: ' + error.message, 'error');
    }
}

async function loadDatasetInfo() {
    try {
        const response = await fetch(`${API_URL}/datasets`);
        const data = await response.json();
        const infoBox = document.getElementById('datasetInfo');
        
        if (data.datasets && data.datasets.length > 0) {
            infoBox.innerHTML = `
                <p><strong>Nama File Aktif:</strong> ${data.datasets[0]}</p>
                <p style="margin-top:6px;"><strong>Total Baris Aturan Ter-indeks:</strong> ${data.totalDocuments || 0} Baris Korpus</p>
                <p style="font-size:12px; color:var(--success); margin-top:8px;">✓ Siap di-retrieve secara semantik oleh mesin AI Groq.</p>
            `;
        } else {
            infoBox.innerHTML = '<p style="color:var(--danger);">Belum ada file CSV korpus akademik yang ter-upload di folder data/.</p>';
        }
    } catch (error) {
        console.error('Error loading dataset info:', error);
    }
}

async function uploadDatasetCSV() {
    const fileInput = document.getElementById('csvFileInput');
    if (fileInput.files.length === 0) return;

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async function(e) {
        const textContent = e.target.result;
        try {
            const response = await fetch(`${API_URL}/datasets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: file.name,
                    data: textContent
                })
            });

            const result = await response.json();
            if (response.ok) {
                showNotification("Dataset korpus akademik sukses di-upload & di-indeks!", "success");
                loadDatasetInfo();
            } else {
                showNotification("Gagal memuat file CSV: " + result.message, "error");
            }
        } catch (error) {
            showNotification("Error koneksi upload: " + error.message, "error");
        }
    };

    reader.readAsText(file);
}

function clearForm() {
    document.getElementById('keyword').value = '';
    document.getElementById('response').value = '';
    document.getElementById('keyword').focus();
}

// Jalankan pemeriksaan berkala status bot whatsapp
checkBotStatus();
setInterval(checkBotStatus, 5000);