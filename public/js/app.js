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
let chartMain;
let chartNPK;
let chartTimeOrigin = Date.now();
let lastStatusData = null;

// ==========================================
// 1. LOGIN & ROUTING SYSTEM (SPA)
// ==========================================
function doLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUser').value;
    const p = document.getElementById('loginPass').value;
    if(u === '1' && p === '1') {
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
        'dashboard': 'Tổng Quan', 'settings': 'Giám Sát',
        'alerts': 'Cảnh Báo', 'history': 'Lịch Sử'
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || 'AutoFertilizer';


    if(window.innerWidth <= 768) toggleSidebar(false);

    if(pageId === 'alerts') renderAlerts();
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
    const sysSocket = document.getElementById('sysSocket'); if (sysSocket) sysSocket.textContent = 'Đã kết nối';
    const monServer = document.getElementById('monServer'); if (monServer) monServer.classList.add('online');
    const monMQTT = document.getElementById('monMQTT'); if (monMQTT) monMQTT.classList.add('online');
    const sysConnMQTT = document.getElementById('sysConnMQTT'); if (sysConnMQTT) sysConnMQTT.textContent = 'Đã kết nối';
    
    // Dashboard new elements
    const mqttDash = document.getElementById('sysConnMQTT_dash');
    const mqttDot = document.getElementById('mqtt-dot');
    if(mqttDash) mqttDash.textContent = 'Đã kết nối Broker';
    if(mqttDot) mqttDot.style.background = 'var(--success)';
    
    // Update state-* elements in dashboard status card
    const stSocket = document.getElementById('state-socket');
    const stMqtt = document.getElementById('state-mqtt');
    const dotSocket = document.getElementById('dot-socket');
    const dotMqtt = document.getElementById('dot-mqtt');
    if(stSocket) { stSocket.textContent = 'Đã kết nối'; stSocket.style.color = 'var(--success)'; }
    if(stMqtt) { stMqtt.textContent = 'Đã kết nối'; stMqtt.style.color = 'var(--success)'; }
    if(dotSocket) dotSocket.style.background = '#16a34a';
    if(dotMqtt) dotMqtt.style.background = '#16a34a';
    
    syncStatus();
});

socket.on('disconnect', () => {
    console.log('Disconnected from Server');
    isOnline = false;
    const sysSocket = document.getElementById('sysSocket'); if (sysSocket) sysSocket.textContent = 'Mất kết nối';
    const monServer = document.getElementById('monServer'); if (monServer) monServer.classList.remove('online');
    const monMQTT = document.getElementById('monMQTT'); if (monMQTT) monMQTT.classList.remove('online');
    const sysConnMQTT = document.getElementById('sysConnMQTT'); if (sysConnMQTT) sysConnMQTT.textContent = 'Mất kết nối';
    
    // Dashboard new elements
    const mqttDash2 = document.getElementById('sysConnMQTT_dash');
    const mqttDot2 = document.getElementById('mqtt-dot');
    if(mqttDash2) mqttDash2.textContent = 'Mất kết nối Broker';
    if(mqttDot2) mqttDot2.style.background = 'var(--danger)';
    
    // Update state-* elements
    const stSocketD = document.getElementById('state-socket');
    const stMqttD = document.getElementById('state-mqtt');
    const stEspD = document.getElementById('state-esp');
    const dotSocket = document.getElementById('dot-socket');
    const dotMqtt = document.getElementById('dot-mqtt');
    const dotEsp = document.getElementById('dot-esp');
    if(stSocketD) { stSocketD.textContent = 'Mất kết nối'; stSocketD.style.color = 'var(--danger)'; }
    if(stMqttD) { stMqttD.textContent = 'Mất kết nối'; stMqttD.style.color = 'var(--danger)'; }
    if(stEspD) { stEspD.textContent = 'Mất kết nối'; stEspD.style.color = 'var(--danger)'; }
    if(dotSocket) dotSocket.style.background = '#ef4444';
    if(dotMqtt) dotMqtt.style.background = '#ef4444';
    if(dotEsp) dotEsp.style.background = '#ef4444';
    
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



socket.on('session_started', (sess) => {
    window.currentSession = sess;
    showToast('Đã gửi lệnh đến ESP32', 'success');
    const btnStart = document.getElementById('btnStart'); if(btnStart) btnStart.disabled = true;
    const btnWater = document.getElementById('btnWaterOnly'); if(btnWater) btnWater.disabled = true;
    const btnStop = document.getElementById('btnStop'); if(btnStop) btnStop.disabled = false;
    chartTimeOrigin = Date.now();
    clearChart();
});

socket.on('session_completed', (record) => {
    window.currentSession = null;
    showToast(`Đã hoàn thành phối trộn! Tổng: ${record.total_ml}mL`, 'success');
    const btnStart = document.getElementById('btnStart'); if(btnStart) btnStart.disabled = false;
    const btnWater = document.getElementById('btnWaterOnly'); if(btnWater) btnWater.disabled = false;
    const btnStop = document.getElementById('btnStop'); if(btnStop) btnStop.disabled = true;
    const monTxt = document.getElementById('monStatusTxt'); if(monTxt) monTxt.textContent = 'HOÀN THÀNH';
    const monStat = document.getElementById('monStatus'); if(monStat) monStat.className = 'conn-pill done';
    loadHistory();
});

socket.on('session_stopped', () => {
    window.currentSession = null;
    showToast('Đã dừng khẩn cấp!', 'error');
    const btnStart = document.getElementById('btnStart'); if(btnStart) btnStart.disabled = false;
    const btnWater = document.getElementById('btnWaterOnly'); if(btnWater) btnWater.disabled = false;
    const btnStop = document.getElementById('btnStop'); if(btnStop) btnStop.disabled = true;
    const monTxt = document.getElementById('monStatusTxt'); if(monTxt) monTxt.textContent = 'ĐÃ HỦY';
    const monStat = document.getElementById('monStatus'); if(monStat) monStat.className = 'conn-pill idle';
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

    // Update state-esp in dashboard status card
    const stEspCard = document.getElementById('state-esp');
    const dotEsp = document.getElementById('dot-esp');
    if(stEspCard) { stEspCard.textContent = status ? 'Trực tuyến' : 'Mất kết nối'; stEspCard.style.color = status ? 'var(--success)' : 'var(--danger)'; }
    if(dotEsp) dotEsp.style.background = status ? '#16a34a' : '#ef4444';
    // Update state-mode
    const stMode = document.getElementById('state-mode');
    if(stMode) stMode.textContent = 'Đồng thời';

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
    // Also sync to systemChip as fallback
    if(data.running) {
        if(mStat) mStat.className = 'conn-pill running active';
        if(mTxt) mTxt.textContent = 'ĐANG PHA TRỘN (ĐỒNG THỜI)';
    } else {
        if(mStat) mStat.className = 'conn-pill ' + (data.phase===4 ? 'done' : 'idle');
        if(mTxt) mTxt.textContent = data.phase===4 ? 'HOÀN THÀNH' : 'SẴN SÀNG';
    }
    // Sync state-socket/state-esp/state-mqtt display elements
    const stSocket = document.getElementById('state-socket');
    const stEsp = document.getElementById('state-esp');
    const stMqtt = document.getElementById('state-mqtt');
    const dotSocket = document.getElementById('dot-socket');
    const dotEsp = document.getElementById('dot-esp');
    const dotMqtt = document.getElementById('dot-mqtt');
    if(stSocket) { stSocket.textContent = isOnline ? 'Đã kết nối' : 'Mất kết nối'; stSocket.style.color = isOnline ? 'var(--success)' : 'var(--danger)'; }
    if(stEsp) { stEsp.textContent = espOnline ? 'Trực tuyến' : 'Ngoại tuyến'; stEsp.style.color = espOnline ? 'var(--success)' : 'var(--danger)'; }
    if(stMqtt) { stMqtt.textContent = isOnline ? 'Đã kết nối' : 'Mất kết nối'; stMqtt.style.color = isOnline ? 'var(--success)' : 'var(--danger)'; }
    if(dotSocket) dotSocket.style.background = isOnline ? '#16a34a' : '#ef4444';
    if(dotEsp) dotEsp.style.background = espOnline ? '#16a34a' : '#ef4444';
    if(dotMqtt) dotMqtt.style.background = isOnline ? '#16a34a' : '#ef4444';

    // Realistic Dashboard Sync
    const rdSysTxt = document.getElementById('ov-sys-txt');
    const rdSysDot = document.getElementById('ov-dot-system');
    const rdPumpTxt = document.getElementById('ov-pump-txt');
    const rdPumpDot = document.getElementById('ov-dot-pump');
    
    if(rdSysTxt) {
        rdSysTxt.textContent = data.running ? 'Đang hoạt động' : (data.phase === 4 ? 'Hoàn thành' : 'Chờ lệnh');
        if(rdSysDot) rdSysDot.className = 'ov-chip-dot ' + (data.running ? 'green' : (data.phase === 4 ? 'blue' : ''));
    }
    
    // Update individual flows, angles, volumes and setpoints in diagram
    ['N','P','K'].forEach(ch => {
        const vEl = document.getElementById(`rd-vol${ch}`);
        const valveData = data.valves ? data.valves[ch] : null;
        if(vEl && valveData) vEl.textContent = Math.round(valveData.volume_ml||0);
        
        const steps = valveData ? (valveData.steps || 0) : 0;
        const angleEl = document.getElementById(`rd-a${ch}`);
        if(angleEl) angleEl.textContent = Math.round((steps % 200) * 1.8) + '°';

        const spEl = document.getElementById(`rd-sp${ch}`);
        if(spEl && valveData) spEl.textContent = (valveData.target_lpm||0).toFixed(3);
    });

    // Main Flow Sensor Update
    const mainFlowLpm = data.main_flow_lpm || 0;
    const rdMainF = document.getElementById('rd-fMain');
    const rdTotalF = document.getElementById('rd-fTotal');
    if(rdMainF) rdMainF.textContent = mainFlowLpm.toFixed(2);
    if(rdTotalF) rdTotalF.textContent = mainFlowLpm.toFixed(2);

    // Main Flow
    const monMainF = document.getElementById('flowMain') || document.getElementById('sysFlow');
    const monMainFLarge = document.getElementById('flowMainLarge');
    const monMainVol = document.getElementById('volMain') || document.getElementById('sysVolume');
    const monMainPulse = document.getElementById('pulseMain') || document.getElementById('sysPulses');
    if(monMainF) monMainF.textContent = mainFlowLpm.toFixed(2);
    if(monMainFLarge) monMainFLarge.textContent = mainFlowLpm.toFixed(1);
    if(monMainVol) monMainVol.textContent = Math.round((data.main_volume_ml ?? data.total_volume_ml) || 0);
    if(monMainPulse) monMainPulse.textContent = data.main_pulses || 0;

    const stMain = document.getElementById('stateMain');
    if(stMain) {
        const isFlowing = mainFlowLpm > 0.05;
        stMain.innerHTML = `<span class="state-dot ${isFlowing?'open-dot':'closed-dot'}"></span> <span>${isFlowing?'Đang chảy':'Đang dừng'}</span>`;
    }

    // Cập nhật monitor card bơm chính (sysFlow, sysVolume, sysPulses, sysPumpState, sysValveState)
    const sysFlow = document.getElementById('sysFlow');
    const sysVolume = document.getElementById('sysVolume');
    const sysPulses = document.getElementById('sysPulses');
    const sysPumpState = document.getElementById('sysPumpState');
    const sysValveState = document.getElementById('sysValveState');
    if(sysFlow) sysFlow.textContent = mainFlowLpm.toFixed(2);
    if(sysVolume) sysVolume.textContent = ((data.main_volume_ml ?? data.total_volume_ml ?? 0) / 1000).toFixed(2);
    const sysTargetVolume = document.getElementById('sysTargetVolume');
    if(sysTargetVolume) sysTargetVolume.textContent = (data.target_water_l || 0).toFixed(1);
    if(sysPulses) sysPulses.textContent = data.main_pulses || 0;
    if(sysPumpState) {
        const pumpOn = data.running || mainFlowLpm > 0.05;
        sysPumpState.innerHTML = `<span class="state-dot ${pumpOn?'open-dot':'closed-dot'}"></span> <span>${pumpOn?'Đang chạy':'Đang tắt'}</span>`;
    }
    if(sysValveState) {
        sysValveState.textContent = data.running ? 'Đang Mở' : 'Đã Đóng';
        sysValveState.style.color = data.running ? 'var(--success)' : 'var(--danger)';
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
            if(data.running && (data.phase === idx+1 || data.phase === 10 || data.phase === 100)) {
                c.className = `valve-card active-${ch.toLowerCase()}`;
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
    if(data.running) {
        const t = (Date.now() - chartTimeOrigin) / 1000;
        const timeLabel = t.toFixed(1);
        
        if (typeof chartMain !== 'undefined') {
            chartMain.data.labels.push(timeLabel);
            chartMain.data.datasets[0].data.push(data.main_flow_lpm || 0);
            if(chartMain.data.labels.length > 50) {
                chartMain.data.labels.shift();
                chartMain.data.datasets.forEach(d => d.data.shift());
            }
            chartMain.update('none');
        }
        
        if (typeof chartNPK !== 'undefined') {
            chartNPK.data.labels.push(timeLabel);
            chartNPK.data.datasets[0].data.push(V.N.flow_lpm || 0);
            chartNPK.data.datasets[1].data.push(V.P.flow_lpm || 0);
            chartNPK.data.datasets[2].data.push(V.K.flow_lpm || 0);
            if(chartNPK.data.labels.length > 50) {
                chartNPK.data.labels.shift();
                chartNPK.data.datasets.forEach(d => d.data.shift());
            }
            chartNPK.update('none');
        }
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


}

function updateValve(ch, d) {
    if(!d) return;
    document.getElementById(`flow${ch}`).textContent = parseFloat(d.flow_lpm||0).toFixed(2);
    document.getElementById(`vol${ch}`).textContent = Math.round(d.volume_ml||0);
    
    let targetMl = d.target_ml || 0;
    if (window.currentSession && window.currentSession.calc && window.currentSession.calc[ch]) {
        targetMl = window.currentSession.calc[ch].target_ml || targetMl;
    }
    // Hủy bỏ tình trạng hiển thị mục tiêu về 0 khi kết thúc hoặc reset ESP32
    if (!targetMl || targetMl <= 0) {
        const inputEl = document.getElementById(`input${ch}`);
        if (inputEl && parseFloat(inputEl.value) > 0) {
            targetMl = parseFloat(inputEl.value);
        }
    }
    document.getElementById(`tgt${ch}`).textContent = Math.round(targetMl);
    document.getElementById(`steps${ch}`).textContent = d.steps;
    
    const pulseEl = document.getElementById(`pulse${ch}`);
    if(pulseEl) pulseEl.textContent = d.pulses || 0;

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
        rdVol.textContent = Math.round(d.volume_ml||0);
        const rmPct = 100 - p;
        if(rdBar) rdBar.style.width = rmPct + '%';
        if(rdPct) rdPct.textContent = Math.round(rmPct) + '%';
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
    const ctxMain = document.getElementById('flowChartMain').getContext('2d');
    chartMain = new Chart(ctxMain, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'TỔNG (L/ph)', borderColor: '#17a2b8', backgroundColor: 'rgba(23,162,184,0.1)', data: [], tension: 0.4, fill: true }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false,
            scales: {
                y: { 
                    type: 'linear',
                    display: true,
                    beginAtZero: true, 
                    title: { display: true, text: 'Lưu lượng Tổng (L/phút)', color: '#17a2b8', font: { weight: 'bold' } },
                    grid: { color: 'rgba(0,0,0,0.05)' }, 
                    ticks: { color: '#64748b' } 
                },
                x: { 
                    grid: { color: 'rgba(0,0,0,0.05)' }, 
                    ticks: { color: '#64748b' },
                    title: { display: true, text: 'Thời gian (giây)', color: '#64748b' }
                }
            },
            plugins: { legend: { labels: { color: '#1e293b', font: { weight: 'bold' } } } }
        }
    });

    const ctxNPK = document.getElementById('flowChartNPK').getContext('2d');
    chartNPK = new Chart(ctxNPK, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Đạm (L/ph)', borderColor: '#28a745', backgroundColor: 'rgba(40,167,69,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Lân (L/ph)', borderColor: '#007bff', backgroundColor: 'rgba(0,123,255,0.1)', data: [], tension: 0.4, fill: true },
                { label: 'Kali (L/ph)', borderColor: '#fd7e14', backgroundColor: 'rgba(253,126,20,0.1)', data: [], tension: 0.4, fill: true }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false,
            scales: {
                y: { 
                    type: 'linear',
                    display: true,
                    beginAtZero: true, 
                    title: { display: true, text: 'Lưu lượng NPK (L/phút)', color: '#334155', font: { weight: 'bold' } },
                    grid: { color: 'rgba(0,0,0,0.05)' }, 
                    ticks: { color: '#64748b' } 
                },
                x: { 
                    grid: { color: 'rgba(0,0,0,0.05)' }, 
                    ticks: { color: '#64748b' },
                    title: { display: true, text: 'Thời gian (giây)', color: '#64748b' }
                }
            },
            plugins: { legend: { labels: { color: '#1e293b', font: { weight: 'bold' } } } }
        }
    });
}

function clearChart() {
    if(chartMain) {
        chartMain.data.labels = [];
        chartMain.data.datasets.forEach(d => d.data = []);
        chartMain.update();
    }
    if(chartNPK) {
        chartNPK.data.labels = [];
        chartNPK.data.datasets.forEach(d => d.data = []);
        chartNPK.update();
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



// CẤU HÌNH CÂY TRỒNG VÀ PHỐI TRỘN DINH DƯỠNG ĐỘNG
const DEFAULT_CROPS = {
    'tomato': {
        name: '🍅 Công thức cà chua',
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

    // Người dùng giờ tự chọn số lần tưới, không gán cứng theo map nữa.

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

    // Lượng nước thực cần tưới theo lịch (không dùng tỉ lệ 1/100)
    const waterPerPlantDay = 2.0; 
    const totalWaterDay_Calc = plants * waterPerPlantDay; // Tổng nước cả ngày (L)

    let baseVolN = 0, baseVolP = 0, baseVolK = 0;
    if (stage === 'seedling') { baseVolN = 20; baseVolP = 20; baseVolK = 20; }
    else if (stage === 'vegetative') { baseVolN = 25; baseVolP = 20; baseVolK = 25; }
    else if (stage === 'flowering') { baseVolN = 25; baseVolP = 18; baseVolK = 30; }
    else if (stage === 'fruiting') { baseVolN = 20; baseVolP = 18; baseVolK = 35; }

    // Sử dụng lượng phân thực tế của cả ngày (tính tỉ lệ theo số cây)
    const volN = Math.round((baseVolN * 1000.0 * plants) / 2400.0);
    const volP = Math.round((baseVolP * 1000.0 * plants) / 2400.0);
    const volK = Math.round((baseVolK * 1000.0 * plants) / 2400.0);
    const multiplier = plants / 100; // Giữ lại cho tương thích nếu cần

    // Tính toán liều lượng cho 1 LẦN TƯỚI (Spoon-feeding)
    const cycles = parseInt(document.getElementById('calc-cycles') ? document.getElementById('calc-cycles').value : 1);
    const volN_cycle = Math.round(volN / cycles);
    const volP_cycle = Math.round(volP / cycles);
    const volK_cycle = Math.round(volK / cycles);

    // Áp dụng định lượng cho 1 lần tưới vào các ô input ẩn để truyền xuống server
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
    
    // Hiển thị Bảng Công thức 4 giai đoạn
    const formulaNameEl = document.getElementById('formula-crop-name');
    if (formulaNameEl) formulaNameEl.textContent = crop.name;
    const formulaBodyEl = document.getElementById('crop-formula-body');
    if (formulaBodyEl) {
        formulaBodyEl.innerHTML = ['seedling', 'vegetative', 'flowering', 'fruiting'].map(s => {
            let bN = 0, bP = 0, bK = 0;
            if (s === 'seedling') { bN = 20; bP = 20; bK = 20; }
            else if (s === 'vegetative') { bN = 25; bP = 20; bK = 25; }
            else if (s === 'flowering') { bN = 25; bP = 18; bK = 30; }
            else if (s === 'fruiting') { bN = 20; bP = 18; bK = 35; }

            const vN = Math.round((bN * 1000.0 * plants) / 2400.0);
            const vP = Math.round((bP * 1000.0 * plants) / 2400.0);
            const vK = Math.round((bK * 1000.0 * plants) / 2400.0);
            
            const wDay = totalWaterDay_Calc;

            const isCurrent = s === stage;
            const bg = 'background: #ffffff;';
            const fw = isCurrent ? 'font-weight: 900; color: #1e3a8a;' : 'font-weight: 600; color: #475569;';
            return `
            <tr style="${bg}">
                <td style="padding: 16px 18px; border: 1px solid var(--border); text-align: left; ${fw} font-size: 17px;">${isCurrent ? '👉 ' : ''}${stageNames[s]}</td>
                <td style="padding: 16px 18px; border: 1px solid var(--border); color: #16a34a; font-weight: 700; font-size: 18px;">${vN}</td>
                <td style="padding: 16px 18px; border: 1px solid var(--border); color: #2563eb; font-weight: 700; font-size: 18px;">${vP}</td>
                <td style="padding: 16px 18px; border: 1px solid var(--border); color: #d97706; font-weight: 700; font-size: 18px;">${vK}</td>
                <td style="padding: 16px 18px; border: 1px solid var(--border); color: #0ea5e9; font-weight: 700; font-size: 18px;">${wDay.toFixed(1)}</td>
            </tr>
            `;
        }).join('');
    }
    
    // Bỏ thời gian xả ống +2 phút, chốt đúng thời gian bơm của nước (Lưu lượng chính 80 L/phút)
    const totalDurationMin = (totalWaterDay_Calc / cycles) / 80.0;
    
    const TOTAL_DOSING_LPM = 0.8;
    const totalVol_cycle_mL = volN_cycle + volP_cycle + volK_cycle;
    
    let dosingTimeMin = 0.1;
    if (totalVol_cycle_mL > 0) {
        dosingTimeMin = (totalVol_cycle_mL / 1000) / TOTAL_DOSING_LPM;
    }
    
    if (dosingTimeMin > totalDurationMin) {
        dosingTimeMin = totalDurationMin; // Không được tiêm lâu hơn tổng thời gian bơm nước
    }

    // Cập nhật lên UI (ẩn, hoặc hiển thị)
    if (calcDurationInput) {
        calcDurationInput.value = totalDurationMin;
    }
    const cropNameClean = crop.name.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '').trim();
    const rName = document.getElementById('recipeName');
    if (rName) rName.value = `${cropNameClean} - ${stageNames[stage] || stage} (${plants} gốc, 3-Phase × ${totalDurationMin}m)`;

    // Báo cáo thủy lực cho 1 LẦN TƯỚI (Lưu lượng chính 80 L/phút)
    const Q_MAIN_LPM   = 80.0;   
    const totalWaterL  = Q_MAIN_LPM * totalDurationMin; 
    const waterPerPlant = totalWaterL / plants;
    const totalWaterDay = totalWaterL * cycles;

    // Lưu lượng nước/chu kỳ vào hidden input để _doActualStart() đọc (không dùng 1/100)
    const calcWaterInput = document.getElementById('calc-total-water-l');
    if (calcWaterInput) calcWaterInput.value = totalWaterL.toFixed(3);

    // Lưu lượng setpoint yêu cầu (L/phút) cho 1 lần tưới dựa trên công thức Q = V / t
    const setpointN = totalDurationMin > 0 ? parseFloat(((volN_cycle / 1000.0) / totalDurationMin).toFixed(3)) : 0;
    const setpointP = totalDurationMin > 0 ? parseFloat(((volP_cycle / 1000.0) / totalDurationMin).toFixed(3)) : 0;
    const setpointK = totalDurationMin > 0 ? parseFloat(((volK_cycle / 1000.0) / totalDurationMin).toFixed(3)) : 0;

    const totalWaterML = totalWaterL * 1000;
    const concN = ((volN_cycle / (totalWaterML + volN_cycle)) * 100).toFixed(2);
    const concP = ((volP_cycle / (totalWaterML + volP_cycle)) * 100).toFixed(2);
    const concK = ((volK_cycle / (totalWaterML + volK_cycle)) * 100).toFixed(2);

    const summaryEl = document.getElementById('calc-summary');
    if (summaryEl) {
        summaryEl.innerHTML =
            `<b>Tổng nước/Ngày: <span style="color:#ef4444">${totalWaterDay.toFixed(1)} L</span></b> &nbsp;|&nbsp; ` +
            `Nước/Chu kỳ: <b>${totalWaterL.toFixed(1)} L</b> (<b>${waterPerPlant.toFixed(2)}</b> L/cây) <br/>` +
            `Giai đoạn: <b>${stageNames[stage] || stage}</b> &nbsp;|&nbsp; ` +
            `Thời gian bơm dự kiến: <b>~${dosingTimeMin.toFixed(1)} phút</b>`;
    }

    const tableBodyEl = document.getElementById('calc-table-body');
    if (tableBodyEl) {
        const colors = { N: '#16a34a', P: '#2563eb', K: '#d97706', W: '#0ea5e9' };
        const labels = { N: '🌿 Bồn 1 (Đạm - N)', P: '🌾 Bồn 2 (Lân - P)', K: '🍂 Bồn 3 (Kali - K)', W: '💧 Nước sạch (Main)' };
        tableBodyEl.innerHTML = [
            { ch: 'N', volTotal: volN, volCycle: volN_cycle, sp: setpointN },
            { ch: 'P', volTotal: volP, volCycle: volP_cycle, sp: setpointP },
            { ch: 'K', volTotal: volK, volCycle: volK_cycle, sp: setpointK },
            { ch: 'W', volTotal: totalWaterDay.toFixed(1) + ' L', volCycle: totalWaterL.toFixed(1) + ' L', sp: '-' }
        ].map(row => `
            <tr style="background: #ffffff;">
                <td style="padding:16px 18px; border: 1px solid var(--border); font-weight:700; font-size:18px; color:${colors[row.ch]}">${labels[row.ch]}</td>
                <td style="padding:16px 18px; border: 1px solid var(--border); text-align:center; font-weight:800; font-size:19px; color:#64748b">${row.volTotal}</td>
                <td style="padding:16px 18px; border: 1px solid var(--border); text-align:center; font-weight:900; font-size:20px; color:var(--txt-dark)">${row.volCycle}</td>
                <td style="padding:16px 18px; border: 1px solid var(--border); text-align:center; font-weight:900; font-size:20px; color:#ef4444">${row.sp}</td>
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
    updateDashboardSettingsDisplay();
    showPage('dashboard');
    showToast('Đã tải công thức!', 'success');
}

// ==========================================
// 7. ALERTS
// ==========================================
function addAlert(msg, type = 'error') {
    const time = new Date().toLocaleTimeString('vi-VN');
    alertLog.unshift({ msg, type, time });
    if (alertLog.length > 100) alertLog.pop();
    console.warn(`[Alert][${type}] ${msg}`);
    // Update badge on nav tab
    const tab = document.getElementById('tn-alerts');
    if (tab) {
        let badge = tab.querySelector('.alert-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'alert-badge';
            badge.style.cssText = 'position:absolute;top:4px;right:4px;background:#ef4444;color:white;border-radius:9999px;font-size:10px;font-weight:800;padding:1px 5px;min-width:16px;text-align:center;';
            tab.style.position = 'relative';
            tab.appendChild(badge);
        }
        badge.textContent = alertLog.length;
    }
    // Live re-render if page is visible
    const page = document.getElementById('page-alerts');
    if (page && page.classList.contains('active')) renderAlerts();
}

function renderAlerts() {
    const container = document.getElementById('alertList');
    const empty = document.getElementById('alertEmptyState');
    if (!container || !empty) return;
    if (alertLog.length === 0) {
        empty.style.display = '';
        container.style.display = 'none';
        return;
    }
    empty.style.display = 'none';
    container.style.display = '';
    const colorMap = { error: { bg: 'rgba(239,68,68,0.08)', border: '#ef4444', icon: '❌', label: 'LỖI' }, warning: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚠️', label: 'CẢNH BÁO' }, info: { bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', icon: 'ℹ️', label: 'THÔNG TIN' } };
    container.innerHTML = alertLog.map((a, i) => {
        const c = colorMap[a.type] || colorMap.error;
        return `<div style="display:flex;align-items:flex-start;gap:14px;padding:14px 18px;border-bottom:1px solid var(--border);background:${c.bg};border-left:4px solid ${c.border};">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;">${c.icon}</span>
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:700;color:var(--txt-dark);word-break:break-word;">${a.msg}</div>
                <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;">${a.time}</div>
            </div>
            <span style="background:${c.border};color:white;border-radius:4px;font-size:10px;font-weight:800;padding:2px 6px;white-space:nowrap;flex-shrink:0;">${c.label}</span>
            <button onclick="deleteAlert(${i})" style="background:none;border:none;color:var(--txt-muted);cursor:pointer;font-size:16px;flex-shrink:0;padding:0 4px;">×</button>
        </div>`;
    }).join('');
}

window.deleteAlert = function(index) {
    alertLog.splice(index, 1);
    renderAlerts();
    const tab = document.getElementById('tn-alerts');
    const badge = tab ? tab.querySelector('.alert-badge') : null;
    if (badge) badge.textContent = alertLog.length || '';
    if (!alertLog.length && badge) badge.remove();
};

function saveThresholds() { showToast('Cảnh báo đã bị tắt', 'info'); }

function clearAlertLog() {
    alertLog = [];
    renderAlerts();
    const tab = document.getElementById('tn-alerts');
    const badge = tab ? tab.querySelector('.alert-badge') : null;
    if (badge) badge.remove();
    showToast('Đã xóa toàn bộ cảnh báo', 'info');
}

// ==========================================
// 8. HISTORY & DB
// ==========================================
const translateStatus = (s) => {
    if (s === 'completed') return 'Hoàn thành';
    if (s === 'cancelled') return 'Đã hủy';
    if (s === 'stopped') return 'Đã dừng';
    return s;
};

const translateMode = (m) => {
    if (!m) return '';
    const lo = m.toLowerCase();
    if (lo === 'simultaneous' || lo === 'sim') return 'Đồng thời';
    if (lo === 'sequential' || lo === 'seq') return 'Tuần tự';
    if (lo === 'volume-based') return 'Định lượng';
    return m;
};

function loadHistory() {
    fetch('/api/history').then(r=>r.json()).then(data => {
        const tb = document.getElementById('historyBody');
        const rl = document.getElementById('recentList');
        if(!data.length) {
            if(tb) tb.innerHTML = '<tr><td colspan="10" class="empty-row">Chưa có lịch sử</td></tr>';
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
                     <td><strong>${h.recipe_name}</strong></td>
                     <td><span style="font-weight: 700; color: var(--txt-dark);">${translateMode(h.mode)}</span></td>
                     <td class="n-col">${h.N_ml||0}</td>
                     <td class="p-col">${h.P_ml||0}</td>
                     <td class="k-col">${h.K_ml||0}</td>
                     <td><strong>${(h.N_ml||0) + (h.P_ml||0) + (h.K_ml||0)}</strong></td>
                     <td>${(h.duration_s || 0)}s</td>
                     <td><strong>${h.total_ml||0}</strong> mL</td>
                     <td><span class="status-pill ${pt(h.status)}">${translateStatus(h.status)}</span></td>
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
        let csv = "Thời Gian,Công Thức,Chế Độ,Bồn 1 N (ml),Bồn 2 P (ml),Bồn 3 K (ml),Tổng (ml),Thời Gian Chạy (s),Thể Tích Thực Tế (ml),Trạng Thái\n";
        data.forEach(h => {
            csv += `"${h.timestamp}","${h.recipe_name}","${translateMode(h.mode)}",${h.N_ml||0},${h.P_ml||0},${h.K_ml||0},${(h.N_ml||0)+(h.P_ml||0)+(h.K_ml||0)},${h.duration_s},${h.total_ml},"${translateStatus(h.status)}"\n`;
        });
        // Sử dụng BOM để Excel nhận diện tiếng Việt có dấu đúng cách
        const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Lich_Su_Pha_Tron.csv";
        a.click();
        URL.revokeObjectURL(url);
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
    // Đồng bộ trạng thái checkbox giữa ba trang (System Info, Calibration và Overview Sidebar)
    const id = device === 'pump' ? 'test-pump' : 'test-main-valve';
    const calibId = device === 'pump' ? 'calib-test-pump' : 'calib-test-main-valve';
    const ovId = device === 'pump' ? 'test-pump-overview' : 'test-main-valve-overview';
    const cb = document.getElementById(id);
    const calibCb = document.getElementById(calibId);
    const ovCb = document.getElementById(ovId);
    if (cb) cb.checked = state;
    if (calibCb) calibCb.checked = state;
    if (ovCb) ovCb.checked = state;

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
                showPage('settings');
                showToast(`Đã bắt đầu chu kì tưới hẹn giờ (${durationMin} phút)!`, 'success');
                setTimeout(() => {
                    const monitorGrid = document.getElementById('monitor-grid');
                    if (monitorGrid) monitorGrid.scrollIntoView({ behavior: 'smooth' });
                }, 300);
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

function resetMainVolume() {
    if(!confirm('Bạn có chắc chắn muốn xóa thể tích tích lũy của đường ống chính về 0?')) return;
    fetch('/api/reset-main', {
        method: 'POST'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToast('Đã gửi yêu cầu reset thể tích tích lũy!', 'success');
        } else {
            showToast('Lỗi: ' + (data.error || 'Không xác định'), 'error');
        }
    })
    .catch(err => showToast('Lỗi kết nối server', 'error'));
}

// Khởi tạo khi tải trang
initWatering();
loadCropsDropdown();
syncStatus();
setInterval(syncStatus, 10000); // Đồng bộ lại mỗi 10 giây cho chắc chắn
setInterval(updateDashboardSettingsDisplay, 5000); // Đồng bộ các thông số cài đặt lên Dashboard mỗi 5 giây

