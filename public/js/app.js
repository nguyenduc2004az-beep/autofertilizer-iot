/* ================================================================
   HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG - SPA APP LOGIC
   ================================================================ */

const socket = io();
let isOnline = false;
let espOnline = false;
let simMode = true; // Always default to simultaneous mode
let sysThresholds = {
    minFlow: 0.1,
    maxFlow: 6.0,
    minRSSI: -80,
    timeout: 30
};
let alertLog = [];
let chart;
let chartTimeOrigin = Date.now();
let lastStatusData = null;

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
        fetchAiCalibration();
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
    fetchAiCalibration();
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
        'recipes': 'Công Thức', 'alerts': 'Cảnh Báo', 'history': 'Lịch Sử', 'system': 'Thông Tin Hệ Thống',
        'calibration': 'Hiệu Chuẩn Cảm Biến'
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || 'AutoFertilizer';

    // Clear monitor badge if viewing monitor
    if(pageId === 'monitor') {
        const bm = document.getElementById('tn-badge-monitor');
        if(bm) bm.classList.add('hidden');
    }

    if(window.innerWidth <= 768) toggleSidebar(false);

    if(pageId === 'system') refreshSysInfo();
    if(pageId === 'calibration') loadCalibrationHistory();
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
    console.log('Connected to Server');
    isOnline = true;
    document.getElementById('sysSocket').textContent = 'Đã kết nối';
    document.getElementById('monServer').classList.add('online');
    document.getElementById('monMQTT').classList.add('online');
    document.getElementById('sysConnMQTT').textContent = 'Đã kết nối';
    
    // Dashboard new elements
    const mqttDash = document.getElementById('sysConnMQTT_dash');
    const mqttDot = document.getElementById('mqtt-dot');
    if(mqttDash) mqttDash.textContent = 'Đã kết nối Broker';
    if(mqttDot) mqttDot.style.background = 'var(--success)';
    
    syncStatus();
});

socket.on('disconnect', () => {
    console.log('Disconnected from Server');
    isOnline = false;
    document.getElementById('sysSocket').textContent = 'Mất kết nối';
    document.getElementById('monServer').classList.remove('online');
    document.getElementById('monMQTT').classList.remove('online');
    document.getElementById('sysConnMQTT').textContent = 'Mất kết nối';
    
    // Dashboard new elements
    const mqttDash = document.getElementById('sysConnMQTT_dash');
    const mqttDot = document.getElementById('mqtt-dot');
    if(mqttDash) mqttDash.textContent = 'Mất kết nối Broker';
    if(mqttDot) mqttDot.style.background = 'var(--danger)';
    
    const srvTxt = document.getElementById('ov-server-txt');
    const srvDot = document.getElementById('ov-dot-server');
    if(srvTxt) srvTxt.textContent = 'MẤT KẾT NỐI';
    if(srvDot) srvDot.className = 'ov-chip-dot';
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
        window.currentSession = data.current_session;
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

socket.on('ai_calibration_updated', (data) => {
    updateAiCalibrationUI(data);
});

socket.on('calibration_history_updated', () => {
    loadCalibrationHistory();
});

function updateAiCalibrationUI(data) {
    const aiN = document.getElementById('aiFactorN');
    const aiP = document.getElementById('aiFactorP');
    const aiK = document.getElementById('aiFactorK');
    const aiSamples = document.getElementById('aiSamples');
    if (aiN) aiN.textContent = data.N.toFixed(2);
    if (aiP) aiP.textContent = data.P.toFixed(2);
    if (aiK) aiK.textContent = data.K.toFixed(2);
    if (aiSamples) aiSamples.textContent = data.history_samples;
}

function fetchAiCalibration() {
    fetch('/api/ai-calibration').then(r => r.json()).then(updateAiCalibrationUI).catch(e => console.warn('AI fetch error:', e));
}

socket.on('session_started', (sess) => {
    window.currentSession = sess;
    showToast(`Bắt đầu trộn: ${sess.recipe_name}`, 'success');
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
    chartTimeOrigin = Date.now();
    clearChart();
});

socket.on('session_completed', (record) => {
    window.currentSession = null;
    showToast(`Đã hoàn thành phối trộn! Tổng: ${record.total_ml}mL`, 'success');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('monStatusTxt').textContent = 'HOÀN THÀNH';
    document.getElementById('monStatus').className = 'conn-pill done';
    loadHistory();
});

socket.on('session_stopped', () => {
    window.currentSession = null;
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
    const espDashDot = document.getElementById('esp-dot');
    if(espTxt) espTxt.textContent = status ? 'TRỰC TUYẾN' : 'NGOẠI TUYẾN';
    if(espDot) espDot.className = 'ov-chip-dot ' + (status ? 'green' : '');
    if(espDashDot) espDashDot.style.background = status ? 'var(--success)' : 'var(--danger)';

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
    lastStatusData = data;
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
        mTxt.textContent = 'ĐANG PHA TRỘN (ĐỒNG THỜI)';
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
    const sysRSSIDash = document.getElementById('sysRSSI_dash');
    if(sysRSSI) sysRSSI.textContent = data.wifi_rssi ? data.wifi_rssi + ' DBM' : '--';
    if(sysRSSIDash) sysRSSIDash.textContent = data.wifi_rssi ? data.wifi_rssi + ' dBm' : '--';
    
    if(data.wifi_rssi && data.wifi_rssi < sysThresholds.minRSSI) {
        addAlert(`Tín hiệu WiFi yếu: ${data.wifi_rssi}dBm`, 'warning');
    }

    const V = data.valves;
    if(!V) return;

    // Update Water Tank (Bồn 4) in sheet
    const stWater = document.getElementById('stateWater');
    if(stWater) {
        stWater.innerHTML = `<span class="state-dot ${data.running?'open-dot':'closed-dot'}"></span> <span>${data.running?'Đang mở':'Đã đóng'}</span>`;
    }
    const flWater = document.getElementById('flowWater');
    if(flWater) {
        const waterFlowLpm = Math.max(0, mainFlowLpm - ((V.N.flow_lpm||0) + (V.P.flow_lpm||0) + (V.K.flow_lpm||0)));
        flWater.textContent = waterFlowLpm.toFixed(2) + ' LÍT/PHÚT';
    }

    // Dashboard Stats Update
    if(document.getElementById('dsh-volN')) {
        let tgtN = V.N.target_ml || 0;
        let tgtP = V.P.target_ml || 0;
        let tgtK = V.K.target_ml || 0;
        if (window.currentSession && window.currentSession.calc) {
            if (window.currentSession.calc.N) tgtN = window.currentSession.calc.N.target_ml || tgtN;
            if (window.currentSession.calc.P) tgtP = window.currentSession.calc.P.target_ml || tgtP;
            if (window.currentSession.calc.K) tgtK = window.currentSession.calc.K.target_ml || tgtK;
        }

        // Volume (Current / Target)
        document.getElementById('dsh-volN').textContent = Math.round(V.N.volume_ml||0);
        document.getElementById('dsh-tgtN').textContent = Math.round(tgtN);
        document.getElementById('dsh-volP').textContent = Math.round(V.P.volume_ml||0);
        document.getElementById('dsh-tgtP').textContent = Math.round(tgtP);
        document.getElementById('dsh-volK').textContent = Math.round(V.K.volume_ml||0);
        document.getElementById('dsh-tgtK').textContent = Math.round(tgtK);

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
            if(data.running && (data.phase === idx+1 || data.phase === 10 || data.phase === 100)) { // 10/100 is SIM
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
            if(v.target_ml > 0 && v.steps > 5) {
                if(v.flow_lpm < sysThresholds.minFlow) addAlert(`LƯU LƯỢNG ${ch} RẤT THẤP: ${v.flow_lpm} LÍT/PHÚT`, 'error');
                if(v.flow_lpm > sysThresholds.maxFlow) addAlert(`LƯU LƯỢNG ${ch} QUÁ CAO: ${v.flow_lpm} LÍT/PHÚT`, 'error');
            }
        });
    }

    // Check Flow Timeout System Error
    if (data.error === "FLOW_TIMEOUT") {
        if (!window.flowTimeoutAlertActive) {
            window.flowTimeoutAlertActive = true;
            addAlert("LỖI HỆ THỐNG: KHÔNG CÓ LƯU LƯỢNG PHÂN (CHẠY KHÔ!)", "error");
            showToast("CẢNH BÁO: ĐÃ TỰ ĐỘNG NGẮT BƠM DO KHÔNG CÓ LƯU LƯỢNG!", "error");
        }
    } else {
        window.flowTimeoutAlertActive = false;
    }

    const sysPhase = document.getElementById('sysPhase');
    if(sysPhase) sysPhase.textContent = (data.phase === 10 || data.phase === 100) ? `Đồng thời (${data.phase})` : data.phase;
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

    // Cập nhật giá trị đo đạc trên trang hiệu chuẩn
    if (typeof updateCalibrationUIValues === 'function') {
        updateCalibrationUIValues(data);
    }
}

function updateValve(ch, d) {
    if(!d) return;
    document.getElementById(`flow${ch}`).textContent = parseFloat(d.flow_lpm||0).toFixed(2);
    document.getElementById(`vol${ch}`).textContent = Math.round(d.volume_ml||0);
    
    let targetMl = d.target_ml || 0;
    if (window.currentSession && window.currentSession.calc && window.currentSession.calc[ch]) {
        targetMl = window.currentSession.calc[ch].target_ml || targetMl;
    }
    document.getElementById(`tgt${ch}`).textContent = Math.round(targetMl);
    document.getElementById(`steps${ch}`).textContent = d.steps;

    const p = targetMl > 0 ? Math.min(100, (d.volume_ml / targetMl) * 100) : 0;
    document.getElementById(`pct${ch}`).textContent = Math.round(p);

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
        const remaining = Math.max(0, targetMl - d.volume_ml);
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

function initChart() {
    const ctx = document.getElementById('flowChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Đạm (L/ph)', borderColor: '#28a745', backgroundColor: 'rgba(40,167,69,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Lân (L/ph)', borderColor: '#007bff', backgroundColor: 'rgba(0,123,255,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Kali (L/ph)', borderColor: '#fd7e14', backgroundColor: 'rgba(253,126,20,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'TỔNG (L/ph)', borderColor: '#17a2b8', backgroundColor: 'rgba(23,162,184,0.1)', data: [], tension: 0.4, fill: false, borderDash: [5, 5] }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false,
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#64748b' } },
                x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#64748b' } }
            },
            plugins: { legend: { labels: { color: '#1e293b', font: { weight: 'bold' } } } }
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
function toggleAutoMode(checked) {
    simMode = true; // Always simultaneous mode
    document.getElementById('autoModeText').textContent = 'ĐỒNG THỜI';
    document.getElementById('modeDescText').textContent = 'Mở cùng lúc 3 van. Phù hợp lượng phân lớn.';
}

function startMixing() {
    const n = parseFloat(document.getElementById('inputN').value) || 0;
    const p = parseFloat(document.getElementById('inputP').value) || 0;
    const k = parseFloat(document.getElementById('inputK').value) || 0;
    const calcDurationEl = document.getElementById('calc-duration');
    const durationMin = calcDurationEl ? parseFloat(calcDurationEl.value) : 1.0;
    const totalDosingFlowLpm = parseFloat(((n + p + k) / (durationMin * 1000)).toFixed(3));

    let payload = {
        mode: 'sim',
        recipe_name: document.getElementById('recipeName').value || 'Không tên',
        N_ml: n,
        P_ml: p,
        K_ml: k,
        N_speed: 60,
        P_speed: 60,
        K_speed: 60,
        ratio_N: n,
        ratio_P: p,
        ratio_K: k,
        total_vol_l: (n + p + k) / 1000,
        total_lpm: totalDosingFlowLpm > 0.05 ? totalDosingFlowLpm : 3.0
    };

    fetch('/api/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
    }).then(res => res.json()).then(data => {
        if(data.error) {
            showToast(data.error, 'error');
        } else {
            showToast('Hệ thống đang tính toán & áp dụng tỷ lệ bù trừ AI...', 'info');
            showPage('monitor');
        }
    }).catch(err => showToast('Lỗi gửi lệnh', 'error'));
}

// CẤU HÌNH CÂY TRỒNG VÀ PHỐI TRỘN DINH DƯỠNG ĐỘNG
const DEFAULT_CROPS = {
    'tomato': {
        name: '🍅 Cà chua (Chuẩn Haifa)',
        rates: {
            'seedling':  { n: 222, p: 222, k: 222 },
            'vegetative':{ n: 267, p: 267, k: 267 },
            'flowering': { n: 400, p: 200, k: 600 },
            'fruiting':  { n: 426, p: 255, k: 850 }
        }
    }
};

function getCropsList() {
    let list = {...DEFAULT_CROPS};
    try {
        const stored = localStorage.getItem('custom_crops');
        if (stored) {
            const parsed = JSON.parse(stored);
            Object.assign(list, parsed);
        }
    } catch(e) {
        console.error('Error loading custom crops:', e);
    }
    return list;
}

function loadCropsDropdown(selectedKey = null) {
    const select = document.getElementById('calc-crop');
    if (!select) return;
    const crops = getCropsList();
    select.innerHTML = Object.entries(crops).map(([key, crop]) => `
        <option value="${key}">${crop.name}</option>
    `).join('');
    if (selectedKey && crops[selectedKey]) {
        select.value = selectedKey;
    } else {
        select.value = 'tomato';
    }
    onCropOrStageChange();
}

function showAddCropModal() {
    const modal = document.getElementById('addCropModal');
    if (modal) modal.classList.remove('hidden');
}

function hideAddCropModal() {
    const modal = document.getElementById('addCropModal');
    if (modal) modal.classList.add('hidden');
}

function saveNewCrop() {
    const nameInput = document.getElementById('new-crop-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        showToast('Vui lòng nhập tên cây trồng!', 'error');
        return;
    }

    // NPK rates for 4 stages
    const seedling_n = parseInt(document.getElementById('nc-seedling-n').value) || 0;
    const seedling_p = parseInt(document.getElementById('nc-seedling-p').value) || 0;
    const seedling_k = parseInt(document.getElementById('nc-seedling-k').value) || 0;

    const vegetative_n = parseInt(document.getElementById('nc-vegetative-n').value) || 0;
    const vegetative_p = parseInt(document.getElementById('nc-vegetative-p').value) || 0;
    const vegetative_k = parseInt(document.getElementById('nc-vegetative-k').value) || 0;

    const flowering_n = parseInt(document.getElementById('nc-flowering-n').value) || 0;
    const flowering_p = parseInt(document.getElementById('nc-flowering-p').value) || 0;
    const flowering_k = parseInt(document.getElementById('nc-flowering-k').value) || 0;

    const fruiting_n = parseInt(document.getElementById('nc-fruiting-n').value) || 0;
    const fruiting_p = parseInt(document.getElementById('nc-fruiting-p').value) || 0;
    const fruiting_k = parseInt(document.getElementById('nc-fruiting-k').value) || 0;

    const key = 'custom_' + Date.now();
    
    let customCrops = {};
    try {
        const stored = localStorage.getItem('custom_crops');
        if (stored) customCrops = JSON.parse(stored);
    } catch(e) {}

    customCrops[key] = {
        name: '🌱 ' + name,
        rates: {
            'seedling':   { n: seedling_n, p: seedling_p, k: seedling_k },
            'vegetative': { n: vegetative_n, p: vegetative_p, k: vegetative_k },
            'flowering':  { n: flowering_n, p: flowering_p, k: flowering_k },
            'fruiting':   { n: fruiting_n, p: fruiting_p, k: fruiting_k }
        }
    };

    localStorage.setItem('custom_crops', JSON.stringify(customCrops));
    showToast(`Đã thêm cây trồng: ${name}`, 'success');
    
    if (nameInput) nameInput.value = '';
    
    hideAddCropModal();
    loadCropsDropdown(key);
}

function onCropOrStageChange() {
    const selectCrop = document.getElementById('calc-crop');
    if (!selectCrop) return;
    const cropKey = selectCrop.value;
    const stage  = document.getElementById('calc-stage').value;
    const plants = parseInt(document.getElementById('calc-plants').value) || 100;

    // Thời gian tưới 1 chu kỳ luôn mặc định là 1.0 phút và được khóa lại (readonly)
    const calcDurationInput = document.getElementById('calc-duration');
    if (calcDurationInput) {
        calcDurationInput.value = 1;
    }
    const durationMin_cycle = 1.0; 

    // Số chu kỳ tưới tự động được khóa lại và gán theo giai đoạn sinh trưởng thực tế theo Haifa
    const cyclesMap = {
        'seedling': 10,
        'vegetative': 12,
        'flowering': 18,
        'fruiting': 23
    };
    const cycles = cyclesMap[stage] || 10;
    const calcCyclesInput = document.getElementById('calc-cycles');
    if (calcCyclesInput) {
        calcCyclesInput.value = cycles;
    }

    // Thời gian giãn cách nghỉ tưới (Thực tế theo biểu đồ 24h)
    const restTimes = {
        'seedling': 70,    // 70 phút giãn cách
        'vegetative': 57,   // 57 phút giãn cách
        'flowering': 37,    // 37 phút giãn cách
        'fruiting': 28      // 28 phút giãn cách
    };
    const restTime = restTimes[stage] || 60;

    const crops = getCropsList();
    const crop = crops[cropKey];
    if (!crop) return;

    const rates = crop.rates[stage] || { n: 0, p: 0, k: 0 };
    const multiplier = plants / 100;

    const volN = Math.round(rates.n * multiplier);
    const volP = Math.round(rates.p * multiplier);
    const volK = Math.round(rates.k * multiplier);

    // Tính toán liều lượng cho 1 chu kỳ nhỏ
    const volN_cycle = Math.round(volN / cycles);
    const volP_cycle = Math.round(volP / cycles);
    const volK_cycle = Math.round(volK / cycles);

    // Áp dụng định lượng của 1 chu kỳ châm phân lên các trường dữ liệu thực tế
    const inpN = document.getElementById('inputN');
    const inpP = document.getElementById('inputP');
    const inpK = document.getElementById('inputK');
    if (inpN) inpN.value = volN_cycle;
    if (inpP) inpP.value = volP_cycle;
    if (inpK) inpK.value = volK_cycle;

    const stageNames = {
        'seedling':  'Cây con',
        'vegetative':'Sinh trưởng',
        'flowering': 'Ra hoa',
        'fruiting':  'Nuôi quả'
    };
    
    const cropNameClean = crop.name.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '').trim();
    const rName = document.getElementById('recipeName');
    if (rName) rName.value = `${cropNameClean} - ${stageNames[stage] || stage} (${plants} gốc, ${cycles} chu kỳ × ${durationMin_cycle}m, nghỉ ${restTime}m)`;

    // Báo cáo thủy lực
    const Q_MAIN_LPM   = 120;   // L/min main pipe flow
    const totalWaterL  = Q_MAIN_LPM * durationMin_cycle; // Lượng nước của 1 chu kỳ (1 phút)
    const waterPerPlant = totalWaterL / plants;

    // Lưu lượng setpoint yêu cầu (L/phút) cho 1 chu kỳ
    const setpointN = parseFloat((volN_cycle / (durationMin_cycle * 1000)).toFixed(3));
    const setpointP = parseFloat((volP_cycle / (durationMin_cycle * 1000)).toFixed(3));
    const setpointK = parseFloat((volK_cycle / (durationMin_cycle * 1000)).toFixed(3));

    const totalWaterML = totalWaterL * 1000;
    const concN = ((volN_cycle / (totalWaterML + volN_cycle)) * 100).toFixed(2);
    const concP = ((volP_cycle / (totalWaterML + volP_cycle)) * 100).toFixed(2);
    const concK = ((volK_cycle / (totalWaterML + volK_cycle)) * 100).toFixed(2);

    const summaryEl = document.getElementById('calc-summary');
    if (summaryEl) {
        summaryEl.innerHTML =
            `<b>${plants} cây</b> × ${waterPerPlant.toFixed(2)} L/cây = <b>${totalWaterL.toFixed(0)} L nước/chu kỳ</b> &nbsp;|&nbsp; ` +
            `Giai đoạn: <b>${stageNames[stage] || stage}</b> &nbsp;|&nbsp; ` +
            `Chu kỳ: <b>${cycles} chu kỳ × ${durationMin_cycle} phút (Nghỉ ${restTime} phút)</b>`;
    }

    const tableBodyEl = document.getElementById('calc-table-body');
    if (tableBodyEl) {
        const colors = { N: '#16a34a', P: '#2563eb', K: '#d97706' };
        const labels = { N: '🌿 Bồn 1 (Đạm - N)', P: '🌾 Bồn 2 (Lân - P)', K: '🍂 Bồn 3 (Kali - K)' };
        tableBodyEl.innerHTML = [
            { ch: 'N', volTotal: volN, volCycle: volN_cycle, sp: setpointN, c: concN },
            { ch: 'P', volTotal: volP, volCycle: volP_cycle, sp: setpointP, c: concP },
            { ch: 'K', volTotal: volK, volCycle: volK_cycle, sp: setpointK, c: concK }
        ].map(row => `
            <tr>
                <td style="padding:8px 10px; border:1px solid var(--border); font-weight:700; font-size:14px; color:${colors[row.ch]}">${labels[row.ch]}</td>
                <td style="padding:8px 10px; border:1px solid var(--border); text-align:center; font-weight:800; font-size:15px; color:#64748b">${row.volTotal}</td>
                <td style="padding:8px 10px; border:1px solid var(--border); text-align:center; font-weight:900; font-size:16px; color:var(--txt-dark)">${row.volCycle}</td>
                <td style="padding:8px 10px; border:1px solid var(--border); text-align:center; font-weight:900; font-size:16px; color:#ef4444">${row.sp}</td>
                <td style="padding:8px 10px; border:1px solid var(--border); text-align:center; font-weight:800; font-size:14px; color:var(--txt-dark)">${row.c}%</td>
            </tr>
        `).join('');
    }

    updateDashboardSettingsDisplay();
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
            if(rc) rc.innerHTML = '<div class="recipe-empty">Chưa có công thức nào.</div>';
            if(rdd) rdd.innerHTML = '<p class="empty-hint">Trống</p>';
            return;
        }
        if(rc) {
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
        }
        if(rdd) {
            rdd.innerHTML = data.map(r => `
                <div class="recipe-item">
                    <div onclick="applyRecipe(${r.N_ml},${r.P_ml},${r.K_ml},'${r.name}'); toggleRecipeList(true)" style="flex:1">
                        <div class="recipe-item-name">${r.name}</div>
                        <div class="recipe-item-desc">N:${r.N_ml} | P:${r.P_ml} | K:${r.K_ml}</div>
                    </div>
                    <div class="recipe-del-btn" onclick="event.stopPropagation(); delRecipe('${r.id}')">XÓA</div>
                </div>
            `).join('');
        }
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
            if(tb) tb.innerHTML = '<tr><td colspan="9" class="empty-row">Chưa có lịch sử</td></tr>';
            if(rl) rl.innerHTML = '<div class="recent-empty">Chưa có dữ liệu</div>';
            return;
        }

        // Table
        if (tb) {
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
        }

        // Recent limit 5
        if (rl) {
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
        }

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
    // Legacy timer mode UI elements - guarded for backward compat
    const modeOne = document.getElementById('timerMode-one');
    const modeCyc = document.getElementById('timerMode-cyc');
    const tabOne  = document.getElementById('timerTab-one');
    const tabCyc  = document.getElementById('timerTab-cyc');
    if (modeOne) modeOne.classList.add('hidden');
    if (modeCyc) modeCyc.classList.add('hidden');
    if (tabOne)  tabOne.classList.remove('active');
    if (tabCyc)  tabCyc.classList.remove('active');
    const modeEl = document.getElementById('timerMode-' + mode);
    const tabEl  = document.getElementById('timerTab-' + mode);
    if (modeEl) modeEl.classList.remove('hidden');
    if (tabEl)  tabEl.classList.add('active');
}

// Gửi lệnh điều khiển thủ công (Manual)
function testDevice(device, state) {
    // Đồng bộ trạng thái checkbox giữa hai trang (System Info và Calibration)
    const id = device === 'pump' ? 'test-pump' : 'test-main-valve';
    const calibId = device === 'pump' ? 'calib-test-pump' : 'calib-test-main-valve';
    const cb = document.getElementById(id);
    const calibCb = document.getElementById(calibId);
    if (cb) cb.checked = state;
    if (calibCb) calibCb.checked = state;

    fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'manual', device: device, state: state ? 1 : 0 })
    })
    .then(r => r.json())
    .then(data => {
        if(data.success) showToast(`Đã gửi lệnh: ${device} -> ${state ? 'BẬT' : 'TẮT'}`, 'info');
        else {
            showToast('Lỗi gửi lệnh', 'error');
            if (cb) cb.checked = !state;
            if (calibCb) calibCb.checked = !state;
        }
    })
    .catch(e => {
        showToast('Chưa kết nối Server', 'error');
        if (cb) cb.checked = !state;
        if (calibCb) calibCb.checked = !state;
    });
}

function testStepper(type) {
    const steps = 500; // Hardcoded cho đơn giản
    fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'stepper', type: type, steps: steps })
    })
    .then(r => r.json())
    .then(data => {
        if(data.success) showToast(`Đang chạy xúc rửa Bồn ${type} (500 bước)`, 'info');
        else showToast('Lỗi gửi lệnh', 'error');
    })
    .catch(e => showToast('Chưa kết nối Server', 'error'));
}

function adjTimer(delta) {
    const el = document.getElementById('rd-inp-time');
    if (!el) return; // Legacy element - no longer in DOM
    let val = parseInt(el.value) || 0;
    val = Math.max(1, val + delta);
    el.value = val;
}

function saveTimer() {
    const el = document.getElementById('rd-inp-time');
    const val = el ? (parseInt(el.value) || 30) : 30;
    localStorage.setItem('wateringTime', val);
    
    // Update display in Overview (legacy element - guarded)
    const txt = document.getElementById('ov-timer-val');
    if (txt) txt.textContent = val + ':00';
    
    showToast(`Đã lưu thời gian tưới: ${val} phút`, 'success');
    updateDashboardSettingsDisplay();
}

// Logic lập lịch hẹn (Giao diện tạm)

function loadSchedules() {
    fetch('/api/schedules').then(r=>r.json()).then(data => {
        const list = document.getElementById('scheduleList');
        if(data.length === 0) {
            list.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px; font-style: italic;">Chưa có lịch hẹn nào.</div>';
            updateDashboardSettingsDisplay();
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
        updateDashboardSettingsDisplay();
    });
    
    // We no longer load recipes into timer dropdown since we use direct NPK inputs
}

function delSchedule(id) {
    fetch('/api/schedules/'+id, {method:'DELETE'}).then(()=>{
        showToast('Đã xóa lịch', 'info'); loadSchedules();
    });
}

function addSchedule() {
    const time = document.getElementById('timer-time').value;
    if(!time) { showToast('Vui lòng chọn giờ bắt đầu', 'warning'); return; }
    
    const duration = parseFloat(document.getElementById('calc-duration').value) || 1;
    const n_ml = parseFloat(document.getElementById('inputN').value) || 0;
    const p_ml = parseFloat(document.getElementById('inputP').value) || 0;
    const k_ml = parseFloat(document.getElementById('inputK').value) || 0;
    
    const checks = document.querySelectorAll('.day-chk input:checked');
    if(checks.length === 0) { showToast('Vui lòng chọn ít nhất một ngày tưới!', 'warning'); return; }
    let daysText = Array.from(checks).map(c => c.parentElement.textContent.trim()).join(', ');
    let daysVal = Array.from(checks).map(c => c.value).join(',');
    
    const selectCrop = document.getElementById('calc-crop');
    const cropKey = selectCrop ? selectCrop.value : 'tomato';
    const stage = document.getElementById('calc-stage').value;
    const crops = getCropsList();
    const cropName = crops[cropKey] ? crops[cropKey].name : 'Cây trồng';
    const cropNameClean = cropName.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '').trim();

    const stageNames = {
        'seedling':  'Cây con',
        'vegetative':'Sinh trưởng',
        'flowering': 'Ra hoa',
        'fruiting':  'Nuôi quả'
    };

    let schedStr = `Tưới ${cropNameClean} (${stageNames[stage] || stage}) lúc ${time} vào (${daysText})`;
    
    let payload = {
        kieu_lich: 'cyc',
        n_ml: n_ml,
        p_ml: p_ml,
        k_ml: k_ml,
        thoi_gian_tuoi_phut: duration,
        gio_bat_dau: time,
        so_lan_ngay: 1, // locked to 1
        cach_nhau_gio: 24,
        ngay_lap: daysVal,
        mo_ta: schedStr
    };
    
    fetch('/api/schedules', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    }).then(r=>r.json()).then(data=>{
        if(data.success) {
            showToast('Đã thêm lịch hẹn tưới tự động', 'success');
            loadSchedules();
        } else {
            showToast('Lỗi lưu lịch hẹn', 'error');
        }
    });
}


function initWatering() {
    const saved = localStorage.getItem('wateringTime');
    const val = saved ? parseInt(saved) : 30;
    // Legacy elements (rd-inp-time, ov-timer-txt) no longer in DOM - guarded
    const el  = document.getElementById('rd-inp-time');
    const txt = document.getElementById('ov-timer-txt');
    if (el)  el.value = val;
    if (txt) txt.textContent = val + ':00';

    // Update settings display initially
    setTimeout(updateDashboardSettingsDisplay, 500);
}

// ==========================================
// 10. QUICK ACTION & SETTINGS DISPLAY
// ==========================================
function updateDashboardSettingsDisplay() {
    // 1. Auto mode settings
    const recName = document.getElementById('recipeName') ? document.getElementById('recipeName').value : '';
    const activeRec = document.getElementById('dsh-active-recipe');
    if (activeRec) activeRec.textContent = recName || 'Chưa chọn';

    const setN = document.getElementById('dsh-set-N');
    const setP = document.getElementById('dsh-set-P');
    const setK = document.getElementById('dsh-set-K');
    if (setN) setN.textContent = document.getElementById('inputN') ? (document.getElementById('inputN').value || '0') : '0';
    if (setP) setP.textContent = document.getElementById('inputP') ? (document.getElementById('inputP').value || '0') : '0';
    if (setK) setK.textContent = document.getElementById('inputK') ? (document.getElementById('inputK').value || '0') : '0';

    const activeMode = document.getElementById('dsh-active-mode');
    if (activeMode) {
        activeMode.textContent = 'ĐỒNG THỜI';
        activeMode.style.backgroundColor = '#0ea5e9';
    }

    // 2. Timer settings
    const calcDurationEl = document.getElementById('calc-duration');
    const durationMin = calcDurationEl ? parseFloat(calcDurationEl.value) : 1;
    const setDuration = document.getElementById('dsh-set-duration');
    if (setDuration) setDuration.textContent = durationMin + ' phút';

    // 3. Schedule count
    fetch('/api/schedules').then(r=>r.json()).then(data => {
        const schedCount = document.getElementById('dsh-schedule-count');
        if (schedCount) schedCount.textContent = data.length + ' lịch đang hoạt động';
    }).catch(e => {});
}

function quickStartAuto() {
    const n = parseInt(document.getElementById('inputN').value) || 0;
    const p = parseInt(document.getElementById('inputP').value) || 0;
    const k = parseInt(document.getElementById('inputK').value) || 0;
    if (n === 0 && p === 0 && k === 0) {
        showToast('Bạn có thể nhập trực tiếp thể tích phân bón trong bảng xác nhận!', 'info');
    }
    startMixing();
}

function quickStartTimer() {
    const calcDurationEl = document.getElementById('calc-duration');
    const durationMin = calcDurationEl ? parseFloat(calcDurationEl.value) : 1;
    
    // Thay đổi tiêu đề, mô tả và nội dung của hộp thoại xác nhận (confirmOverlay)
    const iconEl = document.getElementById('confirmIcon');
    const titleEl = document.getElementById('confirmTitle');
    const descEl = document.getElementById('confirmDesc');
    
    if (iconEl) iconEl.textContent = '⏱️';
    if (titleEl) titleEl.textContent = 'Xác nhận bắt đầu hẹn giờ tưới?';
    if (descEl) descEl.textContent = 'Hệ thống sẽ chạy ở chế độ chỉ tưới nước sạch (không châm phân) theo thời gian hẹn giờ.';
    
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;

    const summary = document.getElementById('confirmSummary');
    if (summary) {
        summary.innerHTML = `
            <div class="confirm-summary-row"><span class="cs-label">Chế độ</span><span class="cs-val" style="font-weight: 700; color: #3b82f6;">Chỉ tưới nước sạch (Hẹn giờ)</span></div>
            <div class="confirm-summary-row"><span class="cs-label">🕒 Bắt đầu lúc</span><span class="cs-val"><input type="time" id="confirmStartTime" class="confirm-input-time" style="font-weight: 700; color: #1e293b; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 8px; font-family: inherit; font-size: 15px; outline: none; background: #fff;" value="${currentTime}"></span></div>
            <div class="confirm-summary-row"><span class="cs-label">⏱️ Thời gian tưới</span><span class="cs-val text-primary" style="font-weight: 800; color: #2563eb;">${durationMin} phút</span></div>
            <div class="confirm-summary-row"><span class="cs-label">🌿 Bồn N (Đạm)</span><span class="cs-val" style="color: #64748b; font-style: italic;">0 mL (Tắt)</span></div>
            <div class="confirm-summary-row"><span class="cs-label">🌾 Bồn P (Lân)</span><span class="cs-val" style="color: #64748b; font-style: italic;">0 mL (Tắt)</span></div>
            <div class="confirm-summary-row"><span class="cs-label">🍂 Bồn K (Kali)</span><span class="cs-val" style="color: #64748b; font-style: italic;">0 mL (Tắt)</span></div>
        `;
    }
    
    // Thiết lập hàm thực thi khi nhấn "Bắt đầu ngay" trong confirmOverlay
    window._pendingStartFn = function() {
        let payload = {
            mode: 'seq',
            recipe_name: 'Chỉ tưới nước (Hẹn giờ)',
            N_ml: 0, P_ml: 0, K_ml: 0,
            N_speed: 60, P_speed: 60, K_speed: 60,
            duration_min: durationMin
        };
        
        fetch('/api/start', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        }).then(res => res.json()).then(data => {
            if(data.error) showToast(data.error, 'error');
            else {
                showPage('monitor');
                showToast(`Đã bắt đầu chu kì tưới hẹn giờ (${durationMin} phút)!`, 'success');
            }
        }).catch(err => showToast('Lỗi gửi lệnh', 'error'));
    };
    
    const overlay = document.getElementById('confirmOverlay');
    if (overlay) overlay.classList.remove('hidden');
}

// HÀM TOÀN CỤC ĐIỀU KHIỂN HẸN GIỜ TRỄ (CLIENT-SIDE DELAY START COUNTDOWN WIDGET)
window.startDelayedExecution = function(delayMs, targetTimeStr, startFn) {
    if (window.delayedStartTimer) clearTimeout(window.delayedStartTimer);
    if (window.delayedStartInterval) clearInterval(window.delayedStartInterval);
    
    // Thêm các style keyframe cho animation động nếu chưa có
    if (!document.getElementById('delayedStartStyles')) {
        const style = document.createElement('style');
        style.id = 'delayedStartStyles';
        style.innerHTML = `
            @keyframes slideInUp {
                from { transform: translateY(100%) scale(0.9); opacity: 0; }
                to { transform: translateY(0) scale(1); opacity: 1; }
            }
            @keyframes pulseScale {
                0% { transform: scale(1); }
                50% { transform: scale(1.15); }
                100% { transform: scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    let widget = document.getElementById('delayedStartWidget');
    if (!widget) {
        widget = document.createElement('div');
        widget.id = 'delayedStartWidget';
        widget.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: linear-gradient(135deg, #1e293b, #0f172a);
            border: 1.5px solid #3b82f6;
            box-shadow: 0 12px 28px -5px rgba(59, 130, 246, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.2);
            padding: 16px 20px;
            border-radius: 12px;
            z-index: 9999;
            color: white;
            display: flex;
            flex-direction: column;
            gap: 10px;
            font-family: 'Inter', sans-serif;
            width: 250px;
            box-sizing: border-box;
            animation: slideInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        `;
        document.body.appendChild(widget);
    }
    
    let remainingMs = delayMs;
    
    const updateWidget = () => {
        const totalSec = Math.ceil(remainingMs / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        
        widget.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size: 22px; display: inline-block; animation: pulseScale 1.5s infinite;">⏱️</span>
                <div>
                    <div style="font-weight: 800; font-size: 13px; letter-spacing: 0.5px; color: #f8fafc; text-transform: uppercase;">Đã lên lịch tưới</div>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 1px;">Sẽ chạy lúc: <strong style="color: #60a5fa; font-size: 12px;">${targetTimeStr}</strong></div>
                </div>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; padding-top: 6px; border-top: 1px solid #334155;">
                <div style="font-size: 24px; font-weight: 900; font-family: monospace; color: #3b82f6; letter-spacing: 1px;">
                    ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}
                </div>
                <button onclick="cancelDelayedStart()" style="background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #ef4444; font-weight: 700; font-size: 11px; padding: 6px 12px; border-radius: 6px; cursor: pointer; transition: all 0.2s; outline: none;">
                    ✕ HỦY LỊCH
                </button>
            </div>
        `;
    };
    
    updateWidget();
    
    window.cancelDelayedStart = () => {
        clearTimeout(window.delayedStartTimer);
        clearInterval(window.delayedStartInterval);
        window.delayedStartTimer = null;
        window.delayedStartInterval = null;
        const w = document.getElementById('delayedStartWidget');
        if (w) w.remove();
        showToast('Đã hủy lịch hẹn giờ thành công!', 'warning');
    };
    
    window.delayedStartInterval = setInterval(() => {
        remainingMs -= 1000;
        if (remainingMs <= 0) {
            clearInterval(window.delayedStartInterval);
            window.delayedStartInterval = null;
            const w = document.getElementById('delayedStartWidget');
            if (w) w.remove();
        } else {
            updateWidget();
        }
    }, 1000);
    
    window.delayedStartTimer = setTimeout(() => {
        window.delayedStartTimer = null;
        if (window.delayedStartInterval) clearInterval(window.delayedStartInterval);
        const w = document.getElementById('delayedStartWidget');
        if (w) w.remove();
        showToast('Khởi động thiết bị theo hẹn giờ...', 'success');
        startFn();
    }, delayMs);
    
    showToast(`Đã lên lịch châm nước hẹn giờ tưới vào lúc ${targetTimeStr}!`, 'info');
};

function quickStopAll() {
    stopMixing();
}

// Khởi tạo khi tải trang
initWatering();
loadCropsDropdown();
syncStatus();
setInterval(syncStatus, 10000); // Đồng bộ lại mỗi 10 giây cho chắc chắn
setInterval(updateDashboardSettingsDisplay, 5000); // Đồng bộ các thông số cài đặt lên Dashboard mỗi 5 giây

// ================================================================
// LOGIC HIỆU CHUẨN CẢM BIẾN (PHE CLIENT-SIDE KHÔNG ĐỔI FIRMWARE)
// ================================================================
let calibOffsets = {
    N: 0,
    P: 0,
    K: 0,
    Main: 0
};

let lastCalibRunResults = null;
let calibStartValues = { N: 0, P: 0, K: 0, Main: 0 };
let isCalibRunning = false;

function startCalibrationRun() {
    const btnStart = document.getElementById('btnCalibStart');
    const btnStop = document.getElementById('btnCalibStop');
    const statusEl = document.getElementById('calibRunStatus');
    
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;
    if (statusEl) {
        statusEl.innerHTML = 'Trạng thái: <span style="color: #3b82f6; font-weight: bold;">Đang mở van chính (chờ 5 giây)...</span>';
    }
    
    if (lastStatusData) {
        calibStartValues = {
            N: lastStatusData.valves?.N?.volume_ml || 0,
            P: lastStatusData.valves?.P?.volume_ml || 0,
            K: lastStatusData.valves?.K?.volume_ml || 0,
            Main: lastStatusData.main_volume_ml || lastStatusData.total_volume_ml || 0
        };
    } else {
        calibStartValues = { N: 0, P: 0, K: 0, Main: 0 };
    }
    isCalibRunning = true;
    
    fetch('/api/calibration/start-run', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, 'error');
            isCalibRunning = false;
            resetCalibButtons();
        } else {
            showToast('Đang mở van chính... Bơm sẽ tự khởi động sau 5 giây.', 'info');
            setTimeout(() => {
                if (statusEl && btnStart && btnStart.disabled) {
                    statusEl.innerHTML = 'Trạng thái: <span style="color: #22c55e; font-weight: bold;">Bơm đang chạy hiệu chuẩn...</span>';
                }
            }, 5000);
        }
    })
    .catch(e => {
        isCalibRunning = false;
        showToast('Lỗi kết nối máy chủ', 'error');
        resetCalibButtons();
    });
}

function stopCalibrationRun() {
    const btnStart = document.getElementById('btnCalibStart');
    const btnStop = document.getElementById('btnCalibStop');
    const statusEl = document.getElementById('calibRunStatus');
    
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (statusEl) statusEl.innerHTML = 'Trạng thái: <span style="color: #64748b; font-weight: bold;">Đang dừng và tính toán...</span>';
    
    fetch('/api/calibration/stop-run', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
        isCalibRunning = false;
        if (data.error) {
            showToast(data.error, 'error');
            resetCalibButtons();
        } else if (data.results) {
            showToast('Đã dừng chạy thử hiệu chuẩn!', 'success');
            lastCalibRunResults = data.results;
            
            if (statusEl) {
                statusEl.innerHTML = `Trạng thái: <span style="color: #22c55e; font-weight: bold;">Hoàn thành chu kỳ ${data.cycleId} (${data.duration_s}s)</span>`;
            }
            
            populateCalibCalculation();
        } else {
            resetCalibButtons();
        }
    })
    .catch(e => {
        isCalibRunning = false;
        showToast('Lỗi kết nối máy chủ', 'error');
        resetCalibButtons();
    });
}

function resetCalibButtons() {
    const btnStart = document.getElementById('btnCalibStart');
    const btnStop = document.getElementById('btnCalibStop');
    const statusEl = document.getElementById('calibRunStatus');
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (statusEl) statusEl.innerHTML = 'Trạng thái: Đang chờ chạy thử';
}

function populateCalibCalculation() {
    const selectedSensor = document.getElementById('calib-sensor-select')?.value || 'N';
    const labelEl = document.getElementById('calib-default-factor-label');
    if (labelEl) {
        labelEl.textContent = selectedSensor === 'Main' ? '37.0370 mL/xung' : '0.1700 mL/xung';
    }
    
    if (!lastCalibRunResults) return;
    const pulsesCountEl = document.getElementById('calib-pulses-count');
    const actualVolEl = document.getElementById('calib-actual-vol');
    
    const sensorData = lastCalibRunResults[selectedSensor];
    if (pulsesCountEl && sensorData) {
        pulsesCountEl.value = sensorData.pulses;
    }
    
    if (actualVolEl) actualVolEl.value = '';
    const factorEl = document.getElementById('calib-calculated-factor');
    if (factorEl) factorEl.value = '--';
}

function onCalibSensorChange() {
    populateCalibCalculation();
    syncStatus();
}

function updateCalibrationUIValues(data) {
    const netVol = { N: 0, P: 0, K: 0, Main: 0 };
    const pulses = { N: 0, P: 0, K: 0, Main: 0 };
    
    if (isCalibRunning) {
        netVol.N = Math.max(0, (data.valves?.N?.volume_ml || 0) - calibStartValues.N);
        netVol.P = Math.max(0, (data.valves?.P?.volume_ml || 0) - calibStartValues.P);
        netVol.K = Math.max(0, (data.valves?.K?.volume_ml || 0) - calibStartValues.K);
        netVol.Main = Math.max(0, (data.main_volume_ml || data.total_volume_ml || 0) - calibStartValues.Main);
        
        pulses.N = Math.round(netVol.N / 0.170);
        pulses.P = Math.round(netVol.P / 0.170);
        pulses.K = Math.round(netVol.K / 0.170);
        pulses.Main = Math.round(netVol.Main / 37.037);
    } else if (lastCalibRunResults) {
        netVol.N = lastCalibRunResults.N?.volume_ml || 0;
        netVol.P = lastCalibRunResults.P?.volume_ml || 0;
        netVol.K = lastCalibRunResults.K?.volume_ml || 0;
        netVol.Main = lastCalibRunResults.Main?.volume_ml || 0;
        
        pulses.N = lastCalibRunResults.N?.pulses || 0;
        pulses.P = lastCalibRunResults.P?.pulses || 0;
        pulses.K = lastCalibRunResults.K?.pulses || 0;
        pulses.Main = lastCalibRunResults.Main?.pulses || 0;
    }
    
    // Update Flows (always show current real-time flow)
    const flowN = data.valves?.N?.flow_lpm !== undefined ? data.valves.N.flow_lpm : 0;
    const flowP = data.valves?.P?.flow_lpm !== undefined ? data.valves.P.flow_lpm : 0;
    const flowK = data.valves?.K?.flow_lpm !== undefined ? data.valves.K.flow_lpm : 0;
    const flowMain = data.main_flow_lpm || 0;
    
    const elFlowN = document.getElementById('calib-flowN');
    const elFlowP = document.getElementById('calib-flowP');
    const elFlowK = document.getElementById('calib-flowK');
    const elFlowMain = document.getElementById('calib-flowMain');
    
    if (elFlowN) elFlowN.textContent = flowN.toFixed(2);
    if (elFlowP) elFlowP.textContent = flowP.toFixed(2);
    if (elFlowK) elFlowK.textContent = flowK.toFixed(2);
    if (elFlowMain) elFlowMain.textContent = flowMain.toFixed(2);
    
    // Update Volumes
    const elVolN = document.getElementById('calib-volN');
    const elVolP = document.getElementById('calib-volP');
    const elVolK = document.getElementById('calib-volK');
    const elVolMain = document.getElementById('calib-volMain');
    
    if (elVolN) elVolN.textContent = Math.round(netVol.N);
    if (elVolP) elVolP.textContent = Math.round(netVol.P);
    if (elVolK) elVolK.textContent = Math.round(netVol.K);
    if (elVolMain) elVolMain.textContent = Math.round(netVol.Main);
    
    // Update Pulses
    const elPulseN = document.getElementById('calib-pulseN');
    const elPulseP = document.getElementById('calib-pulseP');
    const elPulseK = document.getElementById('calib-pulseK');
    const elPulseMain = document.getElementById('calib-pulseMain');
    
    if (elPulseN) elPulseN.textContent = pulses.N;
    if (elPulseP) elPulseP.textContent = pulses.P;
    if (elPulseK) elPulseK.textContent = pulses.K;
    if (elPulseMain) elPulseMain.textContent = pulses.Main;

    // Update form's automatic input (if the selected sensor is currently running)
    const selectedSensor = document.getElementById('calib-sensor-select')?.value || 'N';
    const elPulsesCount = document.getElementById('calib-pulses-count');
    if (elPulsesCount && isCalibRunning) {
        elPulsesCount.value = pulses[selectedSensor];
        calculateCalibFactor();
    }
}

function calculateCalibFactor() {
    const pulses = parseInt(document.getElementById('calib-pulses-count')?.value) || 0;
    const actualVol = parseFloat(document.getElementById('calib-actual-vol')?.value) || 0;
    const elCalculated = document.getElementById('calib-calculated-factor');
    
    if (elCalculated) {
        if (pulses <= 0 || actualVol <= 0) {
            elCalculated.value = '--';
        } else {
            const factor = actualVol / pulses;
            elCalculated.value = factor.toFixed(5) + ' mL/xung';
        }
    }
}

function sendCalibStepperCmd() {
    const type = document.getElementById('calib-stepper-sel').value;
    const steps = parseInt(document.getElementById('calib-stepper-steps').value) || 0;
    if (steps <= 0) {
        showToast('Vui lòng nhập số bước hợp lệ (>0)', 'warning');
        return;
    }
    
    fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'stepper', type, steps })
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) showToast(data.error, 'error');
        else showToast(`Đã gửi lệnh quay van ${type} thêm ${steps} bước`, 'success');
    })
    .catch(e => showToast('Lỗi kết nối máy chủ', 'error'));
}

function saveNewPulseFactor(e) {
    if (e) e.preventDefault();
    const sensor = document.getElementById('calib-sensor-select').value;
    const pulses = parseInt(document.getElementById('calib-pulses-count').value) || 0;
    const actual_vol = parseFloat(document.getElementById('calib-actual-vol').value) || 0;
    
    if (pulses <= 0 || actual_vol <= 0) {
        showToast('Vui lòng hoàn thành chu kỳ chạy thử và nhập thể tích thực tế đo được hợp lệ!', 'warning');
        return;
    }
    
    const factor = parseFloat((actual_vol / pulses).toFixed(5));
    
    fetch('/api/calibration/update-firmware', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sensor, factor })
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, 'error');
        } else {
            showToast(`Đã lưu hệ số cảm biến ${sensor} = ${data.factor} vào file code ESP32!`, 'success');
            
            fetch('/api/calibration/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sensor,
                    actual_ml: actual_vol,
                    pulses,
                    notes: `Cập nhật hệ số xung: ${data.factor} mL/xung`
                })
            })
            .then(() => {
                loadCalibrationHistory();
                alert(`Hệ số đã ghi nhận vào file code ESP32!\n\nBạn hãy mở Arduino IDE và nạp lại chương trình (Flash code) cho ESP32 để áp dụng và kiểm tra giá trị hiệu chỉnh mới.`);
            });
        }
    })
    .catch(e => showToast('Lỗi kết nối máy chủ khi ghi code', 'error'));
}

function loadCalibrationHistory() {
    const tbody = document.getElementById('calibrationHistoryBody');
    if (!tbody) return;
    
    fetch('/api/calibration/history')
    .then(r => r.json())
    .then(list => {
        if (!list || list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="empty-row" style="text-align: center; padding: 20px;">Chưa có chu kỳ chạy thử hiệu chuẩn nào.</td></tr>`;
            return;
        }
        
        tbody.innerHTML = list.map(item => {
            const timeStr = new Date(item.timestamp).toLocaleString('vi-VN');
            const sensorLabel = {
                'N': 'Bồn 1 (N)',
                'P': 'Bồn 2 (P)',
                'K': 'Bồn 3 (K)',
                'Main': 'Ống chính'
            }[item.sensor] || item.sensor;
            
            return `
                <tr>
                    <td>${timeStr}</td>
                    <td style="font-weight: 600; color: #475569;">${item.cycle}</td>
                    <td style="font-weight: bold; color: var(--txt-main);">${sensorLabel}</td>
                    <td style="font-weight: 700; color: #16a34a;">${item.volume_ml} mL</td>
                    <td style="font-weight: 600; color: #2563eb;">${item.pulses}</td>
                    <td style="font-weight: 600; color: #d97706;">${parseFloat(item.flow_lpm).toFixed(2)} L/min</td>
                    <td>${item.duration_s} giây</td>
                    <td style="text-align: center;">
                        <button type="button" class="btn-sm danger" onclick="deleteCalibrationRecord(${item.id})" style="padding: 2px 6px; min-height: 24px; font-size: 11px; color: var(--danger); background: transparent; border: 1px solid var(--danger); border-radius: 4px; cursor: pointer;">
                            Xóa
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    })
    .catch(e => {
        console.error('Lỗi lấy lịch sử hiệu chuẩn:', e);
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row" style="text-align: center; color: var(--danger); padding: 20px;">Lỗi kết nối CSDL!</td></tr>`;
    });
}

function deleteCalibrationRecord(id) {
    if (!confirm('Bạn có chắc chắn muốn xóa bản ghi hiệu chuẩn này?')) return;
    
    fetch(`/api/calibration/history/${id}`, {
        method: 'DELETE'
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showToast(data.error, 'error');
        } else {
            showToast('Đã xóa bản ghi hiệu chuẩn!', 'success');
            loadCalibrationHistory();
        }
    })
    .catch(e => showToast('Lỗi kết nối máy chủ', 'error'));
}

