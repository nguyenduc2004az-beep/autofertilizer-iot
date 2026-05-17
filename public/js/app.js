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
    if(u === 'admin' && p === '123') {
        sessionStorage.setItem('isLogged', '1');
        document.getElementById('loginPage').classList.add('hidden');
        document.getElementById('appShell').classList.remove('hidden');
        showPage('dashboard');
        initChart();
        loadHistory();
        loadRecipes();
        initWatering();
    loadSchedules();
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
    initWatering();
    loadSchedules();
    setInterval(updateClock, 1000);
}

function showPage(pageId) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tn-item').forEach(n => n.classList.remove('active'));

    // Show selected
    const p = document.getElementById('page-' + pageId);
    const n = document.getElementById('tn-' + pageId);
    if(p) p.classList.add('active');
    if(n) n.classList.add('active');

    // Update Title
    const titles = {
        'dashboard': 'Tổng Quan', 'monitor': 'Giám Sát', 'settings': 'Cài Đặt',
        'recipes': 'Công Thức', 'alerts': 'Cảnh Báo', 'history': 'Lịch Sử', 'system': 'Thông Tin Hệ Thống'
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || 'AutoFertilizer';

    // Clear monitor badge if viewing monitor
    if(pageId === 'monitor') {
        const bm = document.getElementById('tn-badge-monitor');
        if(bm) bm.classList.add('hidden');
    }

    if(window.innerWidth <= 768) toggleSidebar(false);

    if(pageId === 'system') refreshSysInfo();
}

function toggleSidebar(forceForce) {
    const sb = document.getElementById('sidebar');
    if(!sb) return; // Fix: Prevent error if sidebar is missing
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
    const srvTxt = document.getElementById('ov-server-txt');
    const srvDot = document.getElementById('ov-dot-server');
    if(srvTxt) srvTxt.textContent = 'TRỰC TUYẾN';
    if(srvDot) srvDot.className = 'ov-chip-dot green';

    document.querySelectorAll('.conn-item')[0].classList.add('online');
    document.getElementById('monMQTT').classList.add('online');
    document.getElementById('sysConnMQTT').textContent = 'Đã kết nối';
    document.getElementById('sysSocket').textContent = 'ID: ' + socket.id;
});

socket.on('disconnect', () => {
    isOnline = false;
    const srvTxt = document.getElementById('ov-server-txt');
    const srvDot = document.getElementById('ov-dot-server');
    if(srvTxt) srvTxt.textContent = 'NGOẠI TUYẾN';
    if(srvDot) srvDot.className = 'ov-chip-dot';
    
    document.querySelectorAll('.conn-item')[0].classList.remove('online');
    document.getElementById('monMQTT').classList.remove('online');
    document.getElementById('sysConnMQTT').textContent = 'Mất kết nối';
    setESPStatus(false);
});

// Thêm hàm đồng bộ trạng thái thủ công để tránh race condition
function syncStatus() {
    fetch('/api/status').then(r => r.json()).then(data => {
        isOnline = true; // Nếu fetch thành công thì server online
        const srvTxt = document.getElementById('ov-server-txt');
        const srvDot = document.getElementById('ov-dot-server');
        if(srvTxt) srvTxt.textContent = 'TRỰC TUYẾN';
        if(srvDot) srvDot.className = 'ov-chip-dot green';

        setESPStatus(data.device_online);
        if(data.last_status) updateUI(data.last_status);
    }).catch(err => {
        console.warn('Sync status failed:', err);
    });
}


socket.on('device_online', (status) => setESPStatus(status));

socket.on('init', (data) => {
    setESPStatus(data.device_online);
    if(data.last_status) updateUI(data.last_status);
});

socket.on('device_status', (data) => {
    if (!espOnline) setESPStatus(true);
    updateUI(data);
});

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
    
    // Dashboard status update
    const espTxt = document.getElementById('ov-esp-txt');
    const espDot = document.getElementById('ov-dot-esp');
    if(espTxt) espTxt.textContent = status ? 'TRỰC TUYẾN' : 'NGOẠI TUYẾN';
    if(espDot) espDot.className = 'ov-chip-dot ' + (status ? 'green' : '');

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
    if(s) s.textContent = status ? 'Trực tuyến' : 'Ngoại tuyến';
    const sState = document.getElementById('sysESPState');
    if(sState) sState.textContent = status ? 'Đang hoạt động' : 'Ngoại tuyến';

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

// Activity Log
function addDshActivity(msg) {
    const log = document.getElementById('dsh-activity-log');
    if(!log) return;
    const item = document.createElement('div');
    item.className = 'activity-item';
    const time = new Date().toLocaleTimeString('vi-VN', {hour12:false});
    item.textContent = `[${time}] ${msg.toUpperCase()}`;
    log.prepend(item);
    if(log.children.length > 20) log.lastElementChild.remove();
}

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
        mTxt.textContent = 'ĐANG PHA TRỘN ' + (simMode ? '(ĐỒNG THỜI)' : `(G.ĐOẠN ${data.phase})`);
    } else {
        mStat.className = 'conn-pill ' + (data.phase===4 ? 'done' : 'idle');
        mTxt.textContent = data.phase===4 ? 'HOÀN THÀNH' : 'SẴN SÀNG';
    }

    // Realistic Dashboard Sync
    const rdSysTxt = document.getElementById('ov-sys-txt');
    const rdSysDot = document.getElementById('ov-dot-system');
    const rdPumpTxt = document.getElementById('ov-pump-txt');
    const rdPumpDot = document.getElementById('ov-dot-pump');
    
    if(rdSysTxt) {
        rdSysTxt.textContent = data.running ? 'Đang hoạt động' : (data.phase === 4 ? 'Hoàn thành' : 'Chờ lệnh');
        if(rdSysDot) rdSysDot.className = 'ov-chip-dot ' + (data.running ? 'green' : (data.phase === 4 ? 'blue' : ''));
    }
    
    // Update individual flows and angles
    ['N','P','K'].forEach(ch => {
        const fEl = document.getElementById(`rd-f${ch}`);
        const valveData = data.valves ? data.valves[ch] : null;
        if(fEl && valveData) fEl.textContent = ((valveData.flow_lpm||0) * 60).toFixed(0);
        
        const steps = valveData ? (valveData.steps || 0) : 0;
        const angleEl = document.getElementById(`rd-a${ch}`);
        if(angleEl) angleEl.textContent = Math.round((steps % 200) * 1.8) + '°';
    });

    // Main Flow Sensor Update
    const mainFlowLpm = data.main_flow_lpm || 0;
    const rdMainF = document.getElementById('rd-fMain');
    const rdTotalF = document.getElementById('rd-fTotal');
    if(rdMainF) rdMainF.textContent = (mainFlowLpm * 60).toFixed(0);
    if(rdTotalF) rdTotalF.textContent = (mainFlowLpm * 60).toFixed(0);

    const monMainF = document.getElementById('flowMain');
    const monMainFLarge = document.getElementById('flowMainLarge');
    const monMainVol = document.getElementById('volMain');
    if(monMainF) monMainF.textContent = mainFlowLpm.toFixed(2);
    if(monMainFLarge) monMainFLarge.textContent = mainFlowLpm.toFixed(1);
    if(monMainVol) monMainVol.textContent = Math.round((data.main_volume_ml ?? data.total_volume_ml) || 0);

    const stMain = document.getElementById('stateMain');
    if(stMain) {
        const isFlowing = mainFlowLpm > 0.05;
        stMain.innerHTML = `<span class="state-dot ${isFlowing?'open-dot':'closed-dot'}"></span> <span>${isFlowing?'Đang chảy':'Đang dừng'}</span>`;
    }

    // Timer
    if(data.duration_sec !== undefined) {
        const tEl = document.getElementById('monTimer');
        if(tEl) tEl.classList.remove('hidden');
        const tvEl = document.getElementById('monTimerVal');
        if(tvEl) tvEl.textContent = formatTime(data.duration_sec);
        
        const rdTimer = document.getElementById('ov-timer-val');
        if(rdTimer) rdTimer.textContent = formatTime(data.duration_sec);
    }

    // System Info
    const sysRSSI = document.getElementById('sysRSSI');
    if(sysRSSI) sysRSSI.textContent = data.wifi_rssi ? data.wifi_rssi + ' DBM' : '--';
    
    if(data.wifi_rssi && data.wifi_rssi < sysThresholds.minRSSI) {
        addAlert(`Tín hiệu WiFi yếu: ${data.wifi_rssi}dBm`, 'warning');
    }

    const V = data.valves;
    if(!V) return;

    // Dashboard Stats Update
    if(document.getElementById('dsh-volN')) {
        // Volume (Current / Target)
        document.getElementById('dsh-volN').textContent = Math.round(V.N.volume_ml||0);
        document.getElementById('dsh-tgtN').textContent = Math.round(V.N.target_ml||0);
        document.getElementById('dsh-volP').textContent = Math.round(V.P.volume_ml||0);
        document.getElementById('dsh-tgtP').textContent = Math.round(V.P.target_ml||0);
        document.getElementById('dsh-volK').textContent = Math.round(V.K.volume_ml||0);
        document.getElementById('dsh-tgtK').textContent = Math.round(V.K.target_ml||0);

        // Flow Velocity
        document.getElementById('dsh-flowN').textContent = parseFloat(V.N.flow_lpm||0).toFixed(2);
        document.getElementById('dsh-flowP').textContent = parseFloat(V.P.flow_lpm||0).toFixed(2);
        document.getElementById('dsh-flowK').textContent = parseFloat(V.K.flow_lpm||0).toFixed(2);
        
        // Stepper Angle (Steps)
        document.getElementById('dsh-step1').textContent = V.N.steps || 0;
        document.getElementById('dsh-step2').textContent = V.P.steps || 0;
        document.getElementById('dsh-step3').textContent = V.K.steps || 0;
    }

    // Phase Cards Highlight
    ['N', 'P', 'K'].forEach((ch, idx) => {
        const c = document.getElementById(`vc${ch}`);
        if(c) {
            if(data.running && (data.phase === idx+1 || data.phase === 10)) { // 10 is SIM
                c.className = `valve-card active-${ch.toLowerCase()}`;
                const badge = document.getElementById('tn-badge-monitor');
                if(badge && !document.getElementById('page-monitor').classList.contains('active')) {
                    badge.classList.remove('hidden');
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
        chart.data.datasets[3].data.push(data.main_flow_lpm || 0);
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
                if(v.flow_lpm < sysThresholds.minFlow) addAlert(`LƯU LƯỢNG ${ch} RẤT THẤP: ${v.flow_lpm} LÍT/PHÚT`, 'error');
                if(v.flow_lpm > sysThresholds.maxFlow) addAlert(`LƯU LƯỢNG ${ch} QUÁ CAO: ${v.flow_lpm} LÍT/PHÚT`, 'error');
            }
        });
    }

    const sysPhase = document.getElementById('sysPhase');
    if(sysPhase) sysPhase.textContent = data.phase === 10 ? 'Đồng thời (10)' : data.phase;
    const sysLastTs = document.getElementById('sysLastTs');
    if(sysLastTs) sysLastTs.textContent = new Date().toLocaleTimeString();

    // Blueprint Animation
    const flowT1 = document.getElementById('flow-top-1');
    const flowT2 = document.getElementById('flow-top-2');
    const flowT3 = document.getElementById('flow-top-3');
    const flowT4 = document.getElementById('flow-top-4');
    const flowD1 = document.getElementById('flow-down-1');
    const flowTank = document.getElementById('flow-tank');
    const flowPump = document.getElementById('flow-pump');
    const flowV1 = document.getElementById('flow-v1');
    const flowV2 = document.getElementById('flow-v2');
    const flowV3 = document.getElementById('flow-v3');
    const sysPump = document.getElementById('sysPump');
    const toggleFlow = (el, run) => { if(el) run ? el.classList.add('running') : el.classList.remove('running'); };

    if(data.running) {
        toggleFlow(flowT1, true); toggleFlow(flowT2, true); toggleFlow(flowT3, true); toggleFlow(flowT4, true);
        toggleFlow(flowD1, true); toggleFlow(flowTank, true); toggleFlow(flowPump, true);
        toggleFlow(flowV1, V.N.steps > 0); toggleFlow(flowV2, V.P.steps > 0); toggleFlow(flowV3, V.K.steps > 0);
        if(sysPump) sysPump.style.filter = 'hue-rotate(90deg)';
        if(rdPumpTxt) { 
            rdPumpTxt.textContent = 'Đang chạy'; 
            if(rdPumpDot) rdPumpDot.className = 'ov-chip-dot green';
        }
        
    } else {
        toggleFlow(flowT1, false); toggleFlow(flowT2, false); toggleFlow(flowT3, false); toggleFlow(flowT4, false);
        toggleFlow(flowD1, false); toggleFlow(flowTank, false); toggleFlow(flowPump, false);
        toggleFlow(flowV1, false); toggleFlow(flowV2, false); toggleFlow(flowV3, false);
        if(sysPump) sysPump.style.filter = 'none';
        if(rdPumpTxt) { 
            rdPumpTxt.textContent = 'Dừng'; 
            if(rdPumpDot) rdPumpDot.className = 'ov-chip-dot';
        }
    }
    
    // Aggregated params
    let totFlow = (V.N.flow_lpm||0) + (V.P.flow_lpm||0) + (V.K.flow_lpm||0);
    const rdFlow = document.getElementById('rd-flow-txt');
    const rdPFlow = document.getElementById('rd-p-flow');
    if(rdFlow) rdFlow.textContent = (totFlow * 60).toFixed(0) + ' L/h';
    if(rdPFlow) rdPFlow.textContent = (totFlow * 60).toFixed(0) + ' L/h';
}

function updateValve(ch, d) {
    if(!d) return;
    document.getElementById(`flow${ch}`).textContent = parseFloat(d.flow_lpm||0).toFixed(2) + ' LÍT/PHÚT';
    document.getElementById(`vol${ch}`).textContent = Math.round(d.volume_ml||0) + ' MILILÍT';
    document.getElementById(`tgt${ch}`).textContent = Math.round(d.target_ml||0) + ' MILILÍT';
    document.getElementById(`steps${ch}`).textContent = d.steps + ' BƯỚC';

    const p = d.target_ml > 0 ? Math.min(100, (d.volume_ml / d.target_ml) * 100) : 0;
    document.getElementById(`pct${ch}`).textContent = Math.round(p) + '%';

    const ring = document.getElementById(`ring${ch}`);
    if(ring) {
        const offset = 314 - (314 * p) / 100;
        ring.style.strokeDashoffset = offset;
    }

    const op = d.steps > 0;
    const st = document.getElementById(`state${ch}`);
    if(st) st.innerHTML = `<span class="state-dot ${op?'open-dot':'closed-dot'}"></span> <span>${op?'Đang mở':'Đã đóng'}</span>`;

    // Flow animation in diagram for suction lines
    const rdVol = document.getElementById(`rd-vol${ch}`);
    const rdBar = document.getElementById(`rd-bar${ch}`);
    const rdPct = document.getElementById(`rd-pct${ch}`);
    if(rdVol) {
        const remaining = Math.max(0, d.target_ml - d.volume_ml);
        rdVol.textContent = (remaining / 1000).toFixed(1);
        const rmPct = 100 - p;
        rdBar.style.width = rmPct + '%';
        rdPct.textContent = Math.round(rmPct) + '%';
    }
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
                { label: 'Đạm (L/ph)', borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Lân (L/ph)', borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Kali (L/ph)', borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'TỔNG (L/ph)', borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.1)', data: [], tension: 0.4, fill: false, borderDash: [5, 5] }
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
            <div class="recipe-item">
                <div onclick="applyRecipe(${r.N_ml},${r.P_ml},${r.K_ml},'${r.name}'); toggleRecipeList(true)" style="flex:1">
                    <div class="recipe-item-name">${r.name}</div>
                    <div class="recipe-item-desc">N:${r.N_ml} | P:${r.P_ml} | K:${r.K_ml}</div>
                </div>
                <div class="recipe-del-btn" onclick="event.stopPropagation(); delRecipe('${r.id}')">XÓA</div>
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
    // Xóa xác nhận trình duyệt để tránh treo agent/browser và tối ưu trải nghiệm
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
    const b1 = document.getElementById('tn-badge-alerts');
    const b2 = document.getElementById('dsh-alertBadge');
    const b3 = document.getElementById('dsh-alertCount');
    if (b1) {
        let c = parseInt(b1.textContent) || 0;
        c++;
        b1.textContent = c; b1.classList.remove('hidden');
    }
    if (b3) b3.textContent = (parseInt(b3.textContent)||0) + 1;
    if (b2) { b2.textContent = 'Mới!'; b2.style.color = '#ef4444'; }
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
    const b1 = document.getElementById('tn-badge-alerts');
    if (b1) {
        b1.textContent = '0';
        b1.classList.add('hidden');
    }
    const b3 = document.getElementById('dsh-alertCount');
    if (b3) b3.textContent = '0';
    const b2 = document.getElementById('dsh-alertBadge');
    if (b2) b2.textContent = '';
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
        document.getElementById('historySummary').textContent = `TỔNG: ${data.length} PHIÊN | ĐÃ PHA: ${window.cachedTotalMl} MILILÍT`;
        const tc = document.getElementById('dsh-totalConsumed');
        if(tc) tc.textContent = window.cachedTotalMl + ' MILILÍT';
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
        let csv = "Thoi_gian,Cong_thuc,Che_do,N_ml,P_ml,K_ml,Tong_ml,Thoi_gian_s,Trang_thai\n";
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

// ==========================================
// 9. ĐIỀU KHIỂN & LẬP LỊCH (TABS)
// ==========================================

function switchCtrlTab(tabId) {
    // Hide all
    document.querySelectorAll('.ctrl-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.ctrl-tab').forEach(t => {
        t.classList.remove('active');
        t.style.fontWeight = '600';
        t.style.color = '#64748b';
        t.style.borderBottomColor = 'transparent';
        t.style.background = 'transparent';
    });
    
    // Show active
    document.getElementById('ctrl-' + tabId).classList.remove('hidden');
    const actBtn = document.getElementById('cTab-' + tabId);
    actBtn.classList.add('active');
    actBtn.style.fontWeight = '700';
    actBtn.style.color = '#3b82f6';
    actBtn.style.borderBottomColor = '#3b82f6';
    actBtn.style.background = 'white';
}

function switchTimerMode(mode) {
    document.getElementById('timerMode-one').classList.add('hidden');
    document.getElementById('timerMode-cyc').classList.add('hidden');
    document.getElementById('timerTab-one').classList.remove('active');
    document.getElementById('timerTab-cyc').classList.remove('active');

    document.getElementById('timerMode-' + mode).classList.remove('hidden');
    document.getElementById('timerTab-' + mode).classList.add('active');
}

// Gửi lệnh điều khiển thủ công (Manual)
function testDevice(device, state) {
    fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'manual', device: device, state: state ? 1 : 0 })
    })
    .then(r => r.json())
    .then(data => {
        if(data.success) showToast(`Đã gửi lệnh: ${device} -> ${state ? 'BẬT' : 'TẮT'}`, 'info');
        else showToast('Lỗi gửi lệnh', 'error');
    })
    .catch(e => showToast('Chưa kết nối Server', 'error'));
}

function testStepper(type) {
    const steps = parseInt(document.getElementById('test-steps-' + type).value) || 0;
    fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'stepper', type: type, steps: steps })
    })
    .then(r => r.json())
    .then(data => {
        if(data.success) showToast(`Test Stepper ${type}: ${steps} bước`, 'info');
        else showToast('Lỗi gửi lệnh', 'error');
    })
    .catch(e => showToast('Chưa kết nối Server', 'error'));
}

function adjTimer(delta) {
    const el = document.getElementById('rd-inp-time');
    if(!el) return;
    let val = parseInt(el.value) || 0;
    val = Math.max(1, val + delta);
    el.value = val;
}

function saveTimer() {
    const el = document.getElementById('rd-inp-time');
    if(!el) return;
    const val = parseInt(el.value) || 30;
    localStorage.setItem('wateringTime', val);
    
    // Update display in Overview
    const txt = document.getElementById('ov-timer-val');
    if(txt) txt.textContent = val + ':00';
    
    showToast(`Đã lưu thời gian tưới: ${val} phút`, 'success');
}

// Logic lập lịch hẹn (Giao diện tạm)

function loadSchedules() {
    fetch('/api/schedules').then(r=>r.json()).then(data => {
        const list = document.getElementById('scheduleList');
        if(data.length === 0) {
            list.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px; font-style: italic;">Chưa có lịch hẹn nào.</div>';
            return;
        }
        
        list.innerHTML = data.map(s => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #f1f5f9;">
                <div>
                    <strong style="color: #334155;">${s.mo_ta}</strong>
                    <div style="font-size: 12px; color: #64748b;">Chạy trong: ${s.thoi_gian_tuoi_phut} phút</div>
                </div>
                <button onclick="delSchedule('${s.ma_lich_hen}')" style="background: #ef4444; color: white; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer;">Xóa</button>
            </div>
        `).join('');
    });
    
    // Also load recipes into timer dropdown
    fetch('/api/recipes').then(r=>r.json()).then(recipes => {
        const sel = document.getElementById('timer-recipe');
        if(!sel) return;
        const oldVal = sel.value;
        sel.innerHTML = '<option value="water_only">💧 Chỉ tưới nước (Không pha phân)</option>' + 
            recipes.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
        if(recipes.some(r=>r.id===oldVal)) sel.value = oldVal;
    });
}

function delSchedule(id) {
    fetch('/api/schedules/'+id, {method:'DELETE'}).then(()=>{
        showToast('Đã xóa lịch', 'info'); loadSchedules();
    });
}

function addSchedule() {
    const isOne = document.getElementById('timerTab-one').classList.contains('active');
    const duration = document.getElementById('rd-inp-time').value;
    const recipeId = document.getElementById('timer-recipe') ? document.getElementById('timer-recipe').value : 'water_only';
    
    let schedStr = '';
    let payload = {
        kieu_lich: isOne ? 'one' : 'cyc',
        cong_thuc_id: recipeId,
        thoi_gian_tuoi_phut: parseInt(duration) || 30
    };

    if (isOne) {
        const dt = document.getElementById('timer-datetime').value;
        if(!dt) { showToast('Vui lòng chọn ngày giờ', 'warning'); return; }
        schedStr = `Tưới 1 lần lúc: ${dt.replace('T', ' ')}`;
        payload.thoi_gian_bat_dau = dt;
    } else {
        const time = document.getElementById('timer-time').value;
        if(!time) { showToast('Vui lòng chọn giờ bắt đầu', 'warning'); return; }
        
        const count = parseInt(document.getElementById('timer-count').value) || 1;
        const interval = parseInt(document.getElementById('timer-interval').value) || 2;
        
        const checks = document.querySelectorAll('.day-chk input:checked');
        if(checks.length === 0) { showToast('Vui lòng chọn ngày lặp lại', 'warning'); return; }
        let daysText = Array.from(checks).map(c => c.parentElement.textContent.trim()).join(', ');
        let daysVal = Array.from(checks).map(c => c.value).join(',');
        
        let freqStr = count > 1 ? ` (${count} lần/ngày, cách nhau ${interval}h)` : ` (1 lần/ngày)`;
        schedStr = `Lặp lại từ ${time} vào (${daysText})${freqStr}`;
        
        payload.gio_bat_dau = time;
        payload.so_lan_ngay = count;
        payload.cach_nhau_gio = interval;
        payload.ngay_lap = daysVal;
    }
    
    payload.mo_ta = schedStr;
    
    fetch('/api/schedules', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    }).then(r=>r.json()).then(data=>{
        if(data.success) {
            showToast('Đã thêm lịch hẹn', 'success');
            loadSchedules();
        } else {
            showToast('Lỗi lưu lịch hẹn', 'error');
        }
    });
}


function initWatering() {
    const saved = localStorage.getItem('wateringTime');
    const val = saved ? parseInt(saved) : 30;
    const el = document.getElementById('rd-inp-time');
    if(el) el.value = val;
    
    const txt = document.getElementById('ov-timer-txt');
    if(txt) txt.textContent = val + ':00';
}

// Khởi tạo khi tải trang
initWatering();
syncStatus();
setInterval(syncStatus, 10000); // Đồng bộ lại mỗi 10 giây cho chắc chắn
