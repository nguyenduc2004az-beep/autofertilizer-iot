/* ================================================================
   HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG - SPA APP LOGIC
   ================================================================ */

const socket = io();
let isOnline = false;
let espOnline = false;
let simMode = false;
let sysThresholds = {
    minFlow: 0.1,
    maxFlow: 6.0,
    minRSSI: -80,
    timeout: 30
};
let alertLog = [];

// ==========================================
// 1. LOGIN & ROUTING SYSTEM (SPA)
// ==========================================
function doLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUser').value;
    const p = document.getElementById('loginPass').value;
    if(u === 'admin' && p === 'admin123') {
        sessionStorage.setItem('isLogged', '1');
        document.getElementById('loginPage').classList.add('hidden');
        document.getElementById('appShell').classList.remove('hidden');
        showPage('dashboard');
        initChart();
        loadHistory();
        loadRecipes();
        showToast('Đăng nhập thành công!', 'success');
        updateClock();
        setInterval(updateClock, 1000);
    } else {
        const err = document.getElementById('loginError');
        err.classList.remove('hidden');
        err.style.animation = 'none';
        setTimeout(() => err.style.animation = 'fadeIn 0.3s ease', 10);
    }
}

function doLogout() {
    sessionStorage.removeItem('isLogged');
    window.location.reload();
}

// Auto check login
if(sessionStorage.getItem('isLogged') === '1') {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    showPage('dashboard');
    initChart();
    loadHistory();
    loadRecipes();
    setInterval(updateClock, 1000);
}

function showPage(pageId) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // Show selected
    const p = document.getElementById('page-' + pageId);
    const n = document.getElementById('nav-' + pageId);
    if(p) p.classList.add('active');
    if(n) n.classList.add('active');

    // Update Title
    const titles = {
        'dashboard': 'Tổng Quan', 'monitor': 'Giám Sát', 'settings': 'Cài Đặt',
        'recipes': 'Công Thức', 'alerts': 'Cảnh Báo', 'history': 'Lịch Sử', 'system': 'Thông Tin Hệ Thống'
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || 'AutoFertilizer';

    // Clear monitor badge if viewing monitor
    if(pageId === 'monitor') document.getElementById('badge-monitor').classList.add('hidden');

    if(window.innerWidth <= 768) toggleSidebar(false);

    if(pageId === 'system') refreshSysInfo();
}

function toggleSidebar(forceForce) {
    const sb = document.getElementById('sidebar');
    if(typeof forceForce === 'boolean') {
        if(forceForce) sb.classList.add('open');
        else sb.classList.remove('open');
    } else {
        sb.classList.toggle('open');
    }
}

function updateClock() {
    const el = document.getElementById('topbarClock');
    if(el) {
        const d = new Date();
        el.textContent = d.toLocaleTimeString('vi-VN');
    }
}

function showToast(msg, type='info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast ${type}`;
    t.classList.remove('hidden');
    setTimeout(() => { t.classList.add('hidden'); }, 3000);
}

// ==========================================
// 2. SOCKET.IO & REAL-TIME LOGIC
// ==========================================
socket.on('connect', () => {
    isOnline = true;
    document.querySelectorAll('.conn-item')[0].classList.add('online');
    document.getElementById('monMQTT').classList.add('online');
    document.getElementById('sysConnMQTT').textContent = 'Đã kết nối';
    document.getElementById('sysSocket').textContent = 'ID: ' + socket.id;
});

socket.on('disconnect', () => {
    isOnline = false;
    document.querySelectorAll('.conn-item')[0].classList.remove('online');
    document.getElementById('monMQTT').classList.remove('online');
    document.getElementById('sysConnMQTT').textContent = 'Mất kết nối';
    setESPStatus(false);
});

socket.on('device_online', (status) => setESPStatus(status));

socket.on('init', (data) => {
    setESPStatus(data.device_online);
    if(data.last_status) updateUI(data.last_status);
});

socket.on('device_status', (data) => updateUI(data));

socket.on('session_started', (sess) => {
    showToast(`Bắt đầu trộn: ${sess.recipe_name}`, 'success');
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
    chartTimeOrigin = Date.now();
    clearChart();
});

socket.on('session_completed', (record) => {
    showToast(`Đã hoàn thành phối trộn! Tổng: ${record.total_ml}mL`, 'success');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('monStatusTxt').textContent = 'HOÀN THÀNH';
    document.getElementById('monStatus').className = 'conn-pill done';
    loadHistory();
});

socket.on('session_stopped', () => {
    showToast('Đã dừng khẩn cấp!', 'error');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('monStatusTxt').textContent = 'ĐÃ HỦY';
    document.getElementById('monStatus').className = 'conn-pill idle';
});

socket.on('history_updated', () => loadHistory());

function setESPStatus(status) {
    espOnline = status;
    const items = document.querySelectorAll('.conn-item');
    if(items[1]) {
        if(status) items[1].classList.add('online');
        else items[1].classList.remove('online');
    }
    const mEsp = document.getElementById('monESP');
    if(mEsp) {
        if(status) mEsp.classList.add('online');
        else mEsp.classList.remove('online');
    }

    const s = document.getElementById('sysConnESP');
    if(s) s.textContent = status ? 'Online' : 'Offline';
    document.getElementById('sysESPState').textContent = status ? 'Đang hoạt động' : 'Offline';

    const diag = document.getElementById('diag-esp');
    if(diag) {
        if(status) diag.classList.add('active');
        else diag.classList.remove('active');
    }
    const arrow = document.getElementById('mqttArrow');
    if(arrow) {
        if(status) arrow.style.animationPlayState = 'running';
        else arrow.style.animationPlayState = 'paused';
    }
}

// ==========================================
// 3. UPDATE MONITOR UI
// ==========================================
let currentPhase = 0;
let isRunning = false;

function updateUI(data) {
    // Topbar Chip
    const chip = document.getElementById('systemChip');
    const chipTxt = document.getElementById('systemChipTxt');
    if(data.running) {
        chip.className = 'status-chip running';
        chipTxt.textContent = 'ĐANG CHẠY';
    } else {
        chip.className = 'status-chip ' + (data.phase===4 ? 'done' : 'idle');
        chipTxt.textContent = data.phase===4 ? 'HOÀN THÀNH' : 'SẴN SÀNG';
    }

    // Monitor Status
    isRunning = data.running;
    currentPhase = data.phase;
    const mStat = document.getElementById('monStatus');
    const mTxt = document.getElementById('monStatusTxt');
    if(data.running) {
        mStat.className = 'conn-pill running active';
        mTxt.textContent = 'ĐANG PHA TRỘN ' + (simMode ? '(ĐỒNG THỜI)' : `(PHASE ${data.phase})`);
    } else {
        mStat.className = 'conn-pill ' + (data.phase===4 ? 'done' : 'idle');
        mTxt.textContent = data.phase===4 ? 'HOÀN THÀNH' : 'SẴN SÀNG';
    }

    // Timer
    if(data.duration_sec !== undefined) {
        document.getElementById('monTimer').classList.remove('hidden');
        document.getElementById('monTimerVal').textContent = formatTime(data.duration_sec);
    }

    // RSSI Dashboard
    document.getElementById('dsh-rssi').textContent = data.wifi_rssi ? data.wifi_rssi + ' dBm' : '--dBm';
    document.getElementById('sysRSSI').textContent = data.wifi_rssi ? data.wifi_rssi + ' dBm' : '--';
    if(data.wifi_rssi && data.wifi_rssi < sysThresholds.minRSSI) {
        addAlert(`Tín hiệu WiFi yếu: ${data.wifi_rssi}dBm`, 'warning');
    }

    const V = data.valves;
    if(!V) return;

    // Phase Cards Highlight
    ['N', 'P', 'K'].forEach((ch, idx) => {
        const c = document.getElementById(`vc${ch}`);
        if(c) {
            if(data.running && (data.phase === idx+1 || data.phase === 10)) { // 10 is SIM
                c.className = `valve-card active-${ch.toLowerCase()}`;
                if(!document.getElementById('page-monitor').classList.contains('active')) {
                    document.getElementById('badge-monitor').classList.remove('hidden');
                }
            } else {
                c.className = 'valve-card';
            }
        }
    });

    // Update individual valves
    updateValve('N', V.N);
    updateValve('P', V.P);
    updateValve('K', V.K);

    // Chart update
    if(data.running && typeof chart !== 'undefined') {
        const t = (Date.now() - chartTimeOrigin) / 1000;
        chart.data.labels.push(t.toFixed(1));
        chart.data.datasets[0].data.push(V.N.flow_lpm || 0);
        chart.data.datasets[1].data.push(V.P.flow_lpm || 0);
        chart.data.datasets[2].data.push(V.K.flow_lpm || 0);
        if(chart.data.labels.length > 50) {
            chart.data.labels.shift();
            chart.data.datasets.forEach(d => d.data.shift());
        }
        chart.update('none');
    }

    // Flow Alerts
    if(data.running) {
        ['N', 'P', 'K'].forEach(ch => {
            const v = V[ch];
            if(v.target_ml > 0 && v.steps > 1000) {
                if(v.flow_lpm < sysThresholds.minFlow) addAlert(`Lưu lượng ${ch} rát thấp: ${v.flow_lpm} L/p`, 'error');
                if(v.flow_lpm > sysThresholds.maxFlow) addAlert(`Lưu lượng ${ch} quá cao: ${v.flow_lpm} L/p`, 'error');
            }
        });
    }

    document.getElementById('sysPhase').textContent = data.phase === 10 ? 'Đồng thời (10)' : data.phase;
    document.getElementById('sysLastTs').textContent = new Date().toLocaleTimeString();
}

function updateValve(ch, d) {
    if(!d) return;
    document.getElementById(`flow${ch}`).textContent = parseFloat(d.flow_lpm||0).toFixed(2);
    document.getElementById(`vol${ch}`).textContent = Math.round(d.volume_ml||0);
    document.getElementById(`tgt${ch}`).textContent = Math.round(d.target_ml||0);
    document.getElementById(`steps${ch}`).textContent = d.steps + ' bước';

    const p = d.target_ml > 0 ? Math.min(100, (d.volume_ml / d.target_ml) * 100) : 0;
    document.getElementById(`pct${ch}`).textContent = Math.round(p) + '%';

    const offset = 314 - (314 * p) / 100;
    document.getElementById(`ring${ch}`).style.strokeDashoffset = offset;

    const op = d.steps > 0;
    const st = document.getElementById(`state${ch}`);
    st.innerHTML = `<span class="state-dot ${op?'open-dot':'closed-dot'}"></span> <span>${op?'Đang mở':'Đã đóng'}</span>`;
}

function formatTime(s) {
    const m = Math.floor(s/60);
    const rs = s%60;
    return `${m.toString().padStart(2,'0')}:${rs.toString().padStart(2,'0')}`;
}

// ==========================================
// 4. CHART.JS
// ==========================================
let chart;
let chartTimeOrigin = Date.now();

function initChart() {
    const ctx = document.getElementById('flowChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'N (L/p)', borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'P (L/p)', borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'K (L/p)', borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', data: [], tension: 0.4, fill: true }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false,
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            plugins: { legend: { labels: { color: '#94a3b8' } } }
        }
    });
}

function clearChart() {
    if(chart) {
        chart.data.labels = [];
        chart.data.datasets.forEach(d => d.data = []);
        chart.update();
    }
}

// ==========================================
// 5. SETTINGS FORM LOGIC
// ==========================================
function switchMode(m) {
    if(m === 'seq') {
        simMode = false;
        document.getElementById('tabSeq').classList.add('active');
        document.getElementById('tabSim').classList.remove('active');
        document.getElementById('panelSeq').classList.remove('hidden');
        document.getElementById('panelSim').classList.add('hidden');
    } else {
        simMode = true;
        document.getElementById('tabSim').classList.add('active');
        document.getElementById('tabSeq').classList.remove('active');
        document.getElementById('panelSim').classList.remove('hidden');
        document.getElementById('panelSeq').classList.add('hidden');
        calcRatio();
    }
}

function onInputChange() {
    const n = parseFloat(document.getElementById('inputN').value) || 0;
    const p = parseFloat(document.getElementById('inputP').value) || 0;
    const k = parseFloat(document.getElementById('inputK').value) || 0;
    document.getElementById('totalVol').textContent = Math.round(n+p+k) + ' mL';
}

function calcRatio() {
    const tl = parseFloat(document.getElementById('simTotalVol').value)||0;
    const tlpm = parseFloat(document.getElementById('simTotalLpm').value)||0;
    const n = parseFloat(document.getElementById('ratioN').value)||0;
    const p = parseFloat(document.getElementById('ratioP').value)||0;
    const k = parseFloat(document.getElementById('ratioK').value)||0;

    const tot = n + p + k;
    if(tot === 0) return;

    const setRatio = (ch, val) => {
        const pct = (val/tot)*100;
        document.getElementById(`simPct${ch}`).textContent = Math.round(pct) + '%';
        document.getElementById(`simVol${ch}`).textContent = ((val/tot)*tl).toFixed(2) + ' L';
        document.getElementById(`simLpm${ch}`).textContent = ((val/tot)*tlpm).toFixed(2);
    };
    setRatio('N', n); setRatio('P', p); setRatio('K', k);
}

function startMixing() {
    let payload;
    if(!simMode) {
        payload = {
            mode: 'seq',
            recipe_name: document.getElementById('recipeName').value || 'Không tên',
            N_ml: document.getElementById('inputN').value || 0,
            P_ml: document.getElementById('inputP').value || 0,
            K_ml: document.getElementById('inputK').value || 0,
            N_speed: document.getElementById('speedN').value,
            P_speed: document.getElementById('speedP').value,
            K_speed: document.getElementById('speedK').value
        };
    } else {
        payload = {
            mode: 'sim',
            recipe_name: document.getElementById('simRecipeName').value || 'Tỉ lệ ' + document.getElementById('ratioN').value + ':' + document.getElementById('ratioP').value + ':' + document.getElementById('ratioK').value,
            ratio_N: document.getElementById('ratioN').value || 0,
            ratio_P: document.getElementById('ratioP').value || 0,
            ratio_K: document.getElementById('ratioK').value || 0,
            total_vol_l: document.getElementById('simTotalVol').value || 0,
            total_lpm: document.getElementById('simTotalLpm').value || 0
        };
    }

    fetch('/api/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
    }).then(res => res.json()).then(data => {
        if(data.error) showToast(data.error, 'error');
        else showPage('monitor');
    }).catch(err => showToast('Lỗi gửi lệnh', 'error'));
}

function stopMixing() {
    fetch('/api/stop', { method: 'POST' }).then(() => {
        showToast('Đã gửi lệnh Dừng', 'warning');
    });
}
function sendHome() {
    fetch('/api/home', { method: 'POST' }).then(() => {
        showToast('Đang đưa van về 0', 'info');
    });
}

// ==========================================
// 6. RECIPES
// ==========================================
function loadRecipes() {
    fetch('/api/recipes').then(r=>r.json()).then(data => {
        const rc = document.getElementById('recipeCards');
        const rdd = document.getElementById('recipeListInline');
        if(!data.length) {
            rc.innerHTML = '<div class="recipe-empty">Chưa có công thức nào.</div>';
            rdd.innerHTML = '<p class="empty-hint">Trống</p>';
            return;
        }
        rc.innerHTML = data.map(r => `
            <div class="rc-card">
                <div class="rc-header">
                    <div class="rc-title">${r.name}</div>
                    <div class="rc-date">${new Date(r.created_at).toLocaleDateString()}</div>
                </div>
                <div class="rc-desc">${r.description||'Không có mô tả'}</div>
                <div class="rc-stats">
                    <span class="n-val">N: ${r.N_ml}</span>
                    <span class="p-val">P: ${r.P_ml}</span>
                    <span class="k-val">K: ${r.K_ml}</span>
                </div>
                <div class="rc-actions">
                    <button class="btn-sm n-btn" onclick="applyRecipe(${r.N_ml},${r.P_ml},${r.K_ml},'${r.name}')">Dùng</button>
                    <button class="btn-sm" onclick="delRecipe('${r.id}')">Xóa</button>
                </div>
            </div>
        `).join('');

        rdd.innerHTML = data.map(r => `
            <div class="recipe-item" onclick="applyRecipe(${r.N_ml},${r.P_ml},${r.K_ml},'${r.name}'); toggleRecipeList(true)">
                <div>
                    <div class="recipe-item-name">${r.name}</div>
                    <div class="recipe-item-desc">N:${r.N_ml} | P:${r.P_ml} | K:${r.K_ml}</div>
                </div>
            </div>
        `).join('');
    });
}

function showAddRecipeForm() {
    document.getElementById('addRecipeForm').classList.remove('hidden');
}
function hideAddRecipeForm() {
    document.getElementById('addRecipeForm').classList.add('hidden');
}
function submitNewRecipe() {
    const payload = {
        name: document.getElementById('newRecipeName').value,
        N_ml: document.getElementById('newRecipeN').value,
        P_ml: document.getElementById('newRecipeP').value,
        K_ml: document.getElementById('newRecipeK').value,
        description: document.getElementById('newRecipeDesc').value
    };
    if(!payload.name) return showToast('Nhập tên công thức!', 'error');

    fetch('/api/recipes', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
    }).then(()=> {
        showToast('Đã lưu công thức', 'success');
        hideAddRecipeForm(); loadRecipes();
    });
}
function delRecipe(id) {
    if(!confirm('Xóa công thức này?')) return;
    fetch('/api/recipes/'+id, {method:'DELETE'}).then(()=>{
        showToast('Đã xóa', 'info'); loadRecipes();
    });
}

function toggleRecipeList(forceHide) {
    const d = document.getElementById('recipeDropdown');
    if(forceHide) d.classList.add('hidden');
    else d.classList.toggle('hidden');
}
function applyRecipe(n, p, k, name) {
    document.getElementById('inputN').value = n;
    document.getElementById('inputP').value = p;
    document.getElementById('inputK').value = k;
    document.getElementById('recipeName').value = name;
    onInputChange();
    showPage('settings');
    showToast('Đã tải công thức!', 'success');
}

// ==========================================
// 7. ALERTS
// ==========================================
function saveThresholds() {
    sysThresholds.minFlow = parseFloat(document.getElementById('thrMinFlow').value);
    sysThresholds.maxFlow = parseFloat(document.getElementById('thrMaxFlow').value);
    sysThresholds.minRSSI = parseFloat(document.getElementById('thrRSSI').value);
    sysThresholds.timeout = parseFloat(document.getElementById('thrTimeout').value);
    showToast('Đã lưu cấu hình cảnh báo', 'success');
}

function addAlert(msg, type='error') {
    const ts = new Date().toLocaleTimeString();
    const id = Date.now();
    alertLog.unshift({ id, msg, type, ts });
    if(alertLog.length > 50) alertLog.pop();
    renderAlerts();

    // Alert Badge
    const b1 = document.getElementById('badge-alerts');
    const b2 = document.getElementById('dsh-alertBadge');
    const b3 = document.getElementById('dsh-alertCount');
    let c = parseInt(b1.textContent) || 0;
    c++;
    b1.textContent = c; b1.classList.remove('hidden');
    b3.textContent = c; b2.textContent = 'Mới!'; b2.style.color = '#ef4444';
}

function renderAlerts() {
    const al = document.getElementById('alertLog');
    const ad = document.getElementById('activeAlerts');
    if(alertLog.length === 0) {
        al.innerHTML = '<div class="alert-empty">Trống</div>';
        ad.innerHTML = '<div class="alert-empty">✅ Không có cảnh báo</div>';
        return;
    }

    al.innerHTML = alertLog.map(a => `
        <div class="log-item ${a.type}-log">
            <span class="log-msg">${a.msg}</span>
            <span class="log-time">${a.ts}</span>
        </div>
    `).join('');

    // Active (last 3 errors)
    const acts = alertLog.slice(0,3);
    ad.innerHTML = acts.map(a => `
        <div class="alert-item ${a.type}">
            <div class="alert-icon">${a.type==='error'?'⚠️':'🔔'}</div>
            <div class="alert-content">
                <div class="alert-title">${a.msg}</div>
                <div class="alert-time">${a.ts}</div>
            </div>
        </div>
    `).join('');
}
function clearAlertLog() {
    alertLog = [];
    renderAlerts();
    document.getElementById('badge-alerts').textContent = '0';
    document.getElementById('badge-alerts').classList.add('hidden');
    document.getElementById('dsh-alertCount').textContent = '0';
    document.getElementById('dsh-alertBadge').textContent = '';
}

// ==========================================
// 8. HISTORY & DB
// ==========================================
function loadHistory() {
    fetch('/api/history').then(r=>r.json()).then(data => {
        const tb = document.getElementById('historyBody');
        const rl = document.getElementById('recentList');
        if(!data.length) {
            tb.innerHTML = '<tr><td colspan="9" class="empty-row">Chưa có lịch sử</td></tr>';
            rl.innerHTML = '<div class="recent-empty">Chưa có dữ liệu</div>';
            return;
        }

        // Table
        tb.innerHTML = data.map(h => {
             const dt = new Date(h.timestamp);
             const pt = (s) => (s==='completed'?'pill-completed':(s==='cancelled'?'pill-cancelled':'pill-running'));
             return `
             <tr>
                 <td>${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}</td>
                 <td><strong>${h.recipe_name}</strong> <span style="font-size:10px;color:grey">(${h.mode==='sequential'?'SEQ':'SIM'})</span></td>
                 <td class="n-col">${h.N_ml||0}</td>
                 <td class="p-col">${h.P_ml||0}</td>
                 <td class="k-col">${h.K_ml||0}</td>
                 <td><strong>${h.total_ml||0}</strong></td>
                 <td>${h.duration_s}s</td>
                 <td>${h.wifi_rssi} dBm</td>
                 <td><span class="status-pill ${pt(h.status)}">${h.status}</span></td>
             </tr>
             `;
        }).join('');

        // Recent limit 5
        rl.innerHTML = data.slice(0,5).map(h => {
            const dt = new Date(h.timestamp);
            return `
            <div class="recent-item ${h.status==='completed'?'completed':'cancelled'}">
                <div class="recent-item-header">
                    <span class="recent-item-name">${h.recipe_name}</span>
                    <span class="recent-item-time">${dt.toLocaleTimeString()}</span>
                </div>
                <div class="recent-item-details">
                    Tổng: ${h.total_ml} mL | Thời gian: ${h.duration_s}s
                </div>
            </div>
            `;
        }).join('');

        window.cachedTotalMl = data.reduce((s,i) => s+(i.total_ml||0), 0);
        window.cachedTotalSess = data.length;
        document.getElementById('historySummary').textContent = `Tổng: ${data.length} phiên | Đã pha: ${window.cachedTotalMl} mL`;
        document.getElementById('dsh-totalSessions').textContent = data.length;
        document.getElementById('dsh-totalMl').textContent = window.cachedTotalMl + ' mL';
    });
}

function clearHistory() {
    if(!confirm('XÓA TOÀN BỘ LỊCH SỬ?')) return;
    fetch('/api/history', {method:'DELETE'}).then(()=>{
        showToast('Đã xóa lịch sử', 'success');
        loadHistory();
    });
}
function exportCSV() {
    fetch('/api/history').then(r=>r.json()).then(data => {
        let csv = "Timestamp,Recipe,Mode,N_ml,P_ml,K_ml,Total_ml,Duration_s,Status\n";
        data.forEach(h => {
            csv += `${h.timestamp},${h.recipe_name},${h.mode},${h.N_ml||0},${h.P_ml||0},${h.K_ml||0},${h.total_ml},${h.duration_s},${h.status}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Fertilizer_History.csv";
        a.click();
        URL.revokeObjectURL(url);
    });
}

function refreshSysInfo() {
    fetch('/api/db-stats').then(r=>r.json()).then(data => {
        document.getElementById('dbSessions').textContent = data.sessions_count;
        document.getElementById('dbRecipes').textContent = data.recipes_count;
        document.getElementById('dbTotalMl').textContent = data.total_ml_mixed + ' mL';
        document.getElementById('sysUptime').textContent = Math.floor(performance.now()/1000) + 's (client)';
    });
}
