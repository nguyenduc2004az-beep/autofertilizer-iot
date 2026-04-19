/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║      HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG - ESP32 FIRMWARE      ║
 * ║                                                              ║
 * ║  Phần cứng:                                                  ║
 * ║    - 3x Động cơ bước NEMA 17 + Driver A4988/DRV8825          ║
 * ║    - 3x Van kim 1/4 vòng (Needle Valve 1/4 turn)             ║
 * ║    - 3x Cảm biến lưu lượng YF-S201                          ║
 * ║    - ESP32 DevKit V1                                         ║
 * ║                                                              ║
 * ║  Hai chế độ hoạt động:                                       ║
 * ║    [A] TUẦN TỰ  (start_seq): N → P → K lần lượt             ║
 * ║    [B] ĐỒNG THỜI(start_sim): 3 van mở cùng lúc với          ║
 * ║         P-controller điều chỉnh bước step theo lưu lượng    ║
 * ║                                                              ║
 * ║  MQTT:                                                       ║
 * ║    Subscribe: fert/cmd    Publish: fert/status               ║
 * ║                                                              ║
 * ║  Thư viện cài trong Arduino IDE → Library Manager:           ║
 * ║    1. PubSubClient  by Nick O'Leary  (v2.8+)                 ║
 * ║    2. ArduinoJson   by Benoit Blanchon (v7+)                 ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  NGUYÊN LÝ ĐIỀU KHIỂN THEO TỈ LỆ (Chế độ Đồng Thời)        │
 * │                                                              │
 * │  Web nhập: tỉ lệ N:P:K = 3:2:1, tổng=10L, tổng=3 L/phút   │
 * │  Server tính:                                                │
 * │    N → target_ml=5000, target_lpm=1.50                      │
 * │    P → target_ml=3333, target_lpm=1.00                      │
 * │    K → target_ml=1667, target_lpm=0.50                      │
 * │                                                              │
 * │  ESP32 điều khiển:                                           │
 * │    1. Mở van ban đầu: steps = (target_lpm/Q_MAX)×MAX_STEPS  │
 * │    2. Mỗi 1 giây:                                            │
 * │       error = target_lpm - actual_lpm                        │
 * │       adj   = Kp × error   (Kp = KP_CONTROL bước/L_phút)   │
 * │       new_steps = old_steps + adj  (clamp 0..MAX_OPEN_STEPS) │
 * │       move motor to new_steps                                │
 * │    3. Khi volume_ml ≥ target_ml → đóng van                  │
 * └─────────────────────────────────────────────────────────────┘
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ================================================================
// ★ CẤU HÌNH WIFI & MQTT - CHỈNH SỬA PHẦN NÀY ★
// ================================================================
const char* WIFI_SSID     = "TEN_WIFI_CUA_BAN";       // Tên WiFi
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";           // Mật khẩu WiFi
const char* MQTT_SERVER   = "192.168.1.100";           // IP của laptop chạy server
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";    // Để trống nếu không dùng xác thực
const char* MQTT_PASS     = "";

// ================================================================
// CHÂN GPIO - ĐỘNG CƠ BƯỚC
// ================================================================
//  Van N (Đạm - Nitrogen)
#define STEP_N     13
#define DIR_N      14
#define EN_N       15

// Van P (Lân - Phosphorus)
#define STEP_P     16
#define DIR_P      17
#define EN_P       18

// Van K (Kali - Potassium)
#define STEP_K     19
#define DIR_K      21
#define EN_K       22

// ================================================================
// CHÂN GPIO - CẢM BIẾN LƯU LƯỢNG (YF-S201)
// ================================================================
// Lưu ý: Các chân này phải hỗ trợ interrupt
#define FLOW_N     25
#define FLOW_P     26
#define FLOW_K     27

// LED trạng thái (chân 2 = LED tích hợp trên hầu hết ESP32 DevKit)
#define STATUS_LED  2

// ================================================================
// THÔNG SỐ PHẦN CỨNG
// ================================================================
// NEMA 17: 200 bước/vòng (1.8°/bước)
// A4988: chế độ vi bước 1/8 → 1600 micro-bước/vòng
// MAX_OPEN_STEPS: 1/4 vòng = mở hoàn toàn van kim
#define STEPS_PER_REV   200
#define MICROSTEP       8
#define MAX_OPEN_STEPS  (STEPS_PER_REV * MICROSTEP / 4)   // = 400 bước = 90°

// Độ trễ giữa các micro-bước (µs) - giảm để nhanh hơn, tăng để an toàn hơn
#define STEP_DELAY_US   1000   // 1ms per micro-step edge

// YF-S201 Flow Sensor:
//   Đặc tính: F(Hz) = 7.5 × Q(L/min)
//   Thể tích mỗi xung = 1 / (7.5 × 60) L = 2.222 mL/xung
#define ML_PER_PULSE    2.222f

// Chu kỳ publish và tính flow rate (ms)
#define PUBLISH_INTERVAL    500
#define FLOW_CALC_INTERVAL  1000

// ================================================================
// THÔNG SỐ ĐIỀU KHIỂN PHẢN HỒI (P-Controller)
// ================================================================
// Q_MAX_LPM: Lưu lượng tối đa (L/phút) khi van mở hoàn toàn.
//   *** ĐO THỰC NGHIỆM rồi chỉnh giá trị này! ***
//   Cách đo: mở van 100%, đặt bình 1 lít, bấm giờ → Q_max = 1/thời_gian_phút
#define Q_MAX_LPM       4.0f

// KP_CONTROL: Hệ số tỉ lệ (bước / L_phút sai số)
//   Nếu error = 0.1 L/phút → điều chỉnh KP_CONTROL×0.1 bước
//   Tăng KP nếu phản hồi chậm, giảm nếu bị dao động
#define KP_CONTROL     30.0f

// Vùng chết: bỏ qua sai số nhỏ hơn giá trị này (L/phút)
#define DEADBAND_LPM    0.05f

// Số bước tối đa điều chỉnh mỗi chu kỳ
#define MAX_ADJ_STEPS   8

// Chu kỳ vòng điều khiển (ms)
#define CONTROL_INTERVAL_MS  1000

// ================================================================
// BIẾN TOÀN CỤC
// ================================================================

// --- Bộ đếm xung cảm biến (PHẢI khai báo volatile vì dùng trong ISR) ---
volatile uint32_t pulseN = 0;
volatile uint32_t pulseP = 0;
volatile uint32_t pulseK = 0;

// Snapshot để tính flow rate
uint32_t snapPulseN = 0, snapPulseP = 0, snapPulseK = 0;
float    flowLpmN = 0.0f, flowLpmP = 0.0f, flowLpmK = 0.0f;

// Mục tiêu thể tích (mL)
float targetN = 0.0f, targetP = 0.0f, targetK = 0.0f;

// Phần trăm mở van (0-100) - dùng cho chế độ tuần tự
int speedN = 60, speedP = 60, speedK = 60;

// Vị trí hiện tại của van (số micro-bước từ vị trí đóng)
int32_t posN = 0, posP = 0, posK = 0;

// ---- Biến chế độ ĐỒNG THỜI ----
bool simMode = false;                          // true = chế độ đồng thời đang chạy
float targetLpmN = 0.0f;                       // Lưu lượng mục tiêu van N (L/phút)
float targetLpmP = 0.0f;                       // Lưu lượng mục tiêu van P (L/phút)
float targetLpmK = 0.0f;                       // Lưu lượng mục tiêu van K (L/phút)
bool  doneN = false, doneP = false, doneK = false;  // Van đã đạt đủ lượng?
unsigned long lastControlTime = 0;             // Thời điểm điều khiển cuối

// Trạng thái hệ thống
//   0   = Chờ (Idle)
//   1   = Đang bơm N (tuần tự)
//   2   = Đang bơm P (tuần tự)
//   3   = Đang bơm K (tuần tự)
//   4   = Hoàn thành
//   100 = Đồng thời đang chạy
bool systemRunning = false;
int  currentPhase  = 0;

// Thời điểm các sự kiện cuối
unsigned long lastPublish    = 0;
unsigned long lastFlowCalc   = 0;
unsigned long lastReconnectTry = 0;

// MQTT Topics
const char* TOPIC_CMD    = "fert/cmd";
const char* TOPIC_STATUS = "fert/status";

// Clients
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

// ================================================================
// NGẮT CẢM BIẾN LƯU LƯỢNG (ISR - Interrupt Service Routine)
// ================================================================
void IRAM_ATTR onFlowN() { pulseN++; }
void IRAM_ATTR onFlowP() { pulseP++; }
void IRAM_ATTR onFlowK() { pulseK++; }

// ================================================================
// ĐIỀU KHIỂN ĐỘNG CƠ BƯỚC
// ================================================================

/**
 * Di chuyển stepper motor một số bước chỉ định.
 *   steps > 0 → hướng mở van
 *   steps < 0 → hướng đóng van
 */
void moveStepper(uint8_t stepPin, uint8_t dirPin, uint8_t enPin, int steps) {
    if (steps == 0) return;

    digitalWrite(enPin, LOW);   // Kích hoạt driver (ENABLE tích cực mức THẤP)
    delayMicroseconds(2);       // Trễ setup

    if (steps > 0) {
        digitalWrite(dirPin, HIGH);   // Chiều mở
    } else {
        digitalWrite(dirPin, LOW);    // Chiều đóng
        steps = -steps;
    }
    delayMicroseconds(2);

    for (int i = 0; i < steps; i++) {
        digitalWrite(stepPin, HIGH);
        delayMicroseconds(STEP_DELAY_US);
        digitalWrite(stepPin, LOW);
        delayMicroseconds(STEP_DELAY_US);

        // Cho phép MQTT xử lý giữa chừng để không bị timeout
        if ((i & 0xFF) == 0xFF) {
            mqttClient.loop();
        }
    }
}

/**
 * Mở van đến phần trăm mong muốn (0% = đóng, 100% = mở hoàn toàn).
 */
void openValve(int valve, int percent) {
    int targetSteps = (MAX_OPEN_STEPS * constrain(percent, 0, 100)) / 100;

    switch (valve) {
        case 1: {
            int delta = targetSteps - posN;
            Serial.printf("[VAN N] Mở %d%% → di chuyển %d bước (vị trí: %d)\n",
                          percent, delta, targetSteps);
            moveStepper(STEP_N, DIR_N, EN_N, delta);
            posN = targetSteps;
            break;
        }
        case 2: {
            int delta = targetSteps - posP;
            Serial.printf("[VAN P] Mở %d%% → di chuyển %d bước (vị trí: %d)\n",
                          percent, delta, targetSteps);
            moveStepper(STEP_P, DIR_P, EN_P, delta);
            posP = targetSteps;
            break;
        }
        case 3: {
            int delta = targetSteps - posK;
            Serial.printf("[VAN K] Mở %d%% → di chuyển %d bước (vị trí: %d)\n",
                          percent, delta, targetSteps);
            moveStepper(STEP_K, DIR_K, EN_K, delta);
            posK = targetSteps;
            break;
        }
    }
}

/**
 * Đóng hoàn toàn một van và tắt driver để tiết kiệm điện.
 */
void closeValve(int valve) {
    openValve(valve, 0);
    switch (valve) {
        case 1: digitalWrite(EN_N, HIGH); break;
        case 2: digitalWrite(EN_P, HIGH); break;
        case 3: digitalWrite(EN_K, HIGH); break;
    }
}

/**
 * Dừng khẩn cấp: đóng tất cả van ngay lập tức.
 */
void emergencyStop() {
    Serial.println("\n!!! DỪNG KHẨN CẤP - Đóng tất cả van ngay lập tức !!!\n");
    systemRunning = false;
    currentPhase  = 0;
    simMode       = false;
    doneN = doneP = doneK = false;
    closeValve(1);
    closeValve(2);
    closeValve(3);
}

// ================================================================
// MQTT CALLBACK - Nhận lệnh từ server
// ================================================================
// ================================================================
// ĐIỀU KHIỂN TỈ LỆ - CHẠY ĐỒNG THỜI (P-Controller)
// Gọi trong loop() mỗi CONTROL_INTERVAL_MS ms
// ================================================================
void controlSimultaneous() {
    // Đọc thể tích tích lũy
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE;
    float volP = pulseP * ML_PER_PULSE;
    float volK = pulseK * ML_PER_PULSE;
    interrupts();

    // ---- Van N ----
    if (!doneN && targetN > 0) {
        if (volN >= targetN) {
            closeValve(1);
            doneN = true;
            Serial.printf("[SIM✓] Van N đủ lượng → %.0f/%.0f mL\n", volN, targetN);
        } else {
            float err = targetLpmN - flowLpmN;
            if (fabsf(err) > DEADBAND_LPM) {
                int adj    = (int)constrain(KP_CONTROL * err,
                                            -MAX_ADJ_STEPS, MAX_ADJ_STEPS);
                int newPos = constrain(posN + adj, 0, MAX_OPEN_STEPS);
                if (newPos != posN) {
                    moveStepper(STEP_N, DIR_N, EN_N, newPos - posN);
                    posN = newPos;
                    Serial.printf("[N] err=%+.3f L/m → adj=%+d → pos=%d steps (%d%%)\n",
                                  err, adj, posN,
                                  (int)(posN * 100 / MAX_OPEN_STEPS));
                }
            }
        }
    }

    // ---- Van P ----
    if (!doneP && targetP > 0) {
        if (volP >= targetP) {
            closeValve(2);
            doneP = true;
            Serial.printf("[SIM✓] Van P đủ lượng → %.0f/%.0f mL\n", volP, targetP);
        } else {
            float err = targetLpmP - flowLpmP;
            if (fabsf(err) > DEADBAND_LPM) {
                int adj    = (int)constrain(KP_CONTROL * err,
                                            -MAX_ADJ_STEPS, MAX_ADJ_STEPS);
                int newPos = constrain(posP + adj, 0, MAX_OPEN_STEPS);
                if (newPos != posP) {
                    moveStepper(STEP_P, DIR_P, EN_P, newPos - posP);
                    posP = newPos;
                    Serial.printf("[P] err=%+.3f L/m → adj=%+d → pos=%d steps (%d%%)\n",
                                  err, adj, posP,
                                  (int)(posP * 100 / MAX_OPEN_STEPS));
                }
            }
        }
    }

    // ---- Van K ----
    if (!doneK && targetK > 0) {
        if (volK >= targetK) {
            closeValve(3);
            doneK = true;
            Serial.printf("[SIM✓] Van K đủ lượng → %.0f/%.0f mL\n", volK, targetK);
        } else {
            float err = targetLpmK - flowLpmK;
            if (fabsf(err) > DEADBAND_LPM) {
                int adj    = (int)constrain(KP_CONTROL * err,
                                            -MAX_ADJ_STEPS, MAX_ADJ_STEPS);
                int newPos = constrain(posK + adj, 0, MAX_OPEN_STEPS);
                if (newPos != posK) {
                    moveStepper(STEP_K, DIR_K, EN_K, newPos - posK);
                    posK = newPos;
                    Serial.printf("[K] err=%+.3f L/m → adj=%+d → pos=%d steps (%d%%)\n",
                                  err, adj, posK,
                                  (int)(posK * 100 / MAX_OPEN_STEPS));
                }
            }
        }
    }

    // Kiểm tra hoàn thành tất cả van
    bool nOk = doneN || targetN <= 0;
    bool pOk = doneP || targetP <= 0;
    bool kOk = doneK || targetK <= 0;
    if (nOk && pOk && kOk) {
        currentPhase  = 4;
        systemRunning = false;
        simMode       = false;
        Serial.println("[SIM✓✓] Hoàn thành toàn bộ - chế độ đồng thời!");
    }
}

// ================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    char buf[513];
    length = min(length, (unsigned int)512);
    memcpy(buf, payload, length);
    buf[length] = '\0';

    Serial.printf("\n[MQTT←] Topic: %s\n[MQTT←] Data: %s\n", topic, buf);

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, buf);
    if (err) {
        Serial.printf("[!] Lỗi JSON: %s\n", err.c_str());
        return;
    }

    const char* cmd = doc["cmd"];
    if (!cmd) return;

    // ---- Lệnh BẮT ĐẦU TUẦN TỰ (N→P→K) ----
    if (strcmp(cmd, "start_seq") == 0 || strcmp(cmd, "start") == 0) {
        if (systemRunning) {
            Serial.println("[!] Hệ thống đang chạy. Bỏ qua lệnh start.");
            return;
        }

        targetN = doc["recipe"]["N"]["target_ml"] | 0.0f;
        targetP = doc["recipe"]["P"]["target_ml"] | 0.0f;
        targetK = doc["recipe"]["K"]["target_ml"] | 0.0f;
        speedN  = doc["recipe"]["N"]["speed_percent"] | 60;
        speedP  = doc["recipe"]["P"]["speed_percent"] | 60;
        speedK  = doc["recipe"]["K"]["speed_percent"] | 60;

        Serial.printf("[START] Mục tiêu → N: %.0f mL | P: %.0f mL | K: %.0f mL\n",
                      targetN, targetP, targetK);

        // Reset bộ đếm xung
        noInterrupts();
        pulseN = pulseP = pulseK = 0;
        interrupts();
        snapPulseN = snapPulseP = snapPulseK = 0;

        systemRunning = true;

        // Bắt đầu pha đầu tiên có target > 0
        if (targetN > 0) {
            currentPhase = 1;
            openValve(1, speedN);
            Serial.println("[>] Bắt đầu pha N...");
        } else if (targetP > 0) {
            currentPhase = 2;
            openValve(2, speedP);
            Serial.println("[>] Bắt đầu pha P...");
        } else if (targetK > 0) {
            currentPhase = 3;
            openValve(3, speedK);
            Serial.println("[>] Bắt đầu pha K...");
        } else {
            Serial.println("[!] Không có mục tiêu hợp lệ!");
            systemRunning = false;
        }
    }
    // ---- Lệnh BẮT ĐẦU ĐỒNG THỜI (3 van cùng lúc, có phản hồi) ----
    else if (strcmp(cmd, "start_sim") == 0) {
        if (systemRunning) { Serial.println("[!] Đang chạy, bỏ qua start_sim"); return; }

        targetN    = doc["recipe"]["N"]["target_ml"] | 0.0f;
        targetP    = doc["recipe"]["P"]["target_ml"] | 0.0f;
        targetK    = doc["recipe"]["K"]["target_ml"] | 0.0f;
        targetLpmN = doc["recipe"]["N"]["target_lpm"] | 0.0f;
        targetLpmP = doc["recipe"]["P"]["target_lpm"] | 0.0f;
        targetLpmK = doc["recipe"]["K"]["target_lpm"] | 0.0f;

        // Vị trí mở ban đầu: ước tính từ target_lpm / Q_MAX
        // Công thức: init_steps = (target_lpm / Q_MAX_LPM) × MAX_OPEN_STEPS
        // Override nếu server gửi init_open (%).
        auto initSteps = [](float lpm, int overridePct) -> int {
            if (overridePct > 0) return (MAX_OPEN_STEPS * overridePct) / 100;
            float pct = (lpm / Q_MAX_LPM) * 100.0f;
            return (int)constrain((MAX_OPEN_STEPS * pct / 100.0f), 5, MAX_OPEN_STEPS);
        };
        int initN = initSteps(targetLpmN, doc["recipe"]["N"]["init_open"] | 0);
        int initP = initSteps(targetLpmP, doc["recipe"]["P"]["init_open"] | 0);
        int initK = initSteps(targetLpmK, doc["recipe"]["K"]["init_open"] | 0);

        // Reset pulse counters
        noInterrupts(); pulseN = pulseP = pulseK = 0; interrupts();
        snapPulseN = snapPulseP = snapPulseK = 0;
        doneN = doneP = doneK = false;

        Serial.printf("[SIM] N=%.0fmL@%.2fL/m(step=%d) | P=%.0fmL@%.2fL/m(step=%d) | K=%.0fmL@%.2fL/m(step=%d)\n",
                      targetN, targetLpmN, initN,
                      targetP, targetLpmP, initP,
                      targetK, targetLpmK, initK);

        // Mở tất cả van đến vị trí ước tính ban đầu
        if (targetN > 0) { moveStepper(STEP_N, DIR_N, EN_N, initN - posN); posN = initN; }
        if (targetP > 0) { moveStepper(STEP_P, DIR_P, EN_P, initP - posP); posP = initP; }
        if (targetK > 0) { moveStepper(STEP_K, DIR_K, EN_K, initK - posK); posK = initK; }

        simMode = true;
        systemRunning = true;
        currentPhase  = 100;  // 100 = chế độ đồng thời
        lastControlTime = millis();
        Serial.println("[SIM] Tất cả van đã mở - vòng điều khiển bắt đầu!");
    }

    // ---- Lệnh DỪNG ----
    else if (strcmp(cmd, "stop") == 0) {
        emergencyStop();
    }
    // ---- Lệnh VỀ HOME (đặt lại vị trí gốc) ----
    else if (strcmp(cmd, "home") == 0) {
        if (!systemRunning) {
            closeValve(1); closeValve(2); closeValve(3);
            posN = posP = posK = 0;
            Serial.println("[HOME] Đã về vị trí gốc.");
        }
    }
}

// ================================================================
// KẾT NỐI MQTT
// ================================================================
void mqttReconnect() {
    if (millis() - lastReconnectTry < 5000) return;
    lastReconnectTry = millis();

    String clientId = "ESP32Fert_" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.printf("[MQTT] Kết nối tới %s:%d (id=%s)...\n",
                  MQTT_SERVER, MQTT_PORT, clientId.c_str());

    bool ok;
    if (strlen(MQTT_USER) > 0) {
        ok = mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS);
    } else {
        ok = mqttClient.connect(clientId.c_str());
    }

    if (ok) {
        Serial.println("[MQTT] ✓ Đã kết nối!");
        mqttClient.subscribe(TOPIC_CMD, 1);  // QoS 1
        digitalWrite(STATUS_LED, HIGH);
    } else {
        Serial.printf("[MQTT] ✗ Thất bại (rc=%d). Thử lại sau 5s...\n",
                      mqttClient.state());
        digitalWrite(STATUS_LED, LOW);
    }
}

// ================================================================
// TÍNH LƯU LƯỢNG (L/phút)
// ================================================================
void calculateFlowRates() {
    unsigned long now = millis();
    float dt_s = (now - lastFlowCalc) / 1000.0f;
    if (dt_s < 0.01f) return;

    // Lấy snapshot xung, tắt interrupt tạm thời
    noInterrupts();
    uint32_t pN = pulseN;
    uint32_t pP = pulseP;
    uint32_t pK = pulseK;
    interrupts();

    uint32_t dN = pN - snapPulseN;
    uint32_t dP = pP - snapPulseP;
    uint32_t dK = pK - snapPulseK;

    snapPulseN = pN;
    snapPulseP = pP;
    snapPulseK = pK;

    // YF-S201: Q(L/min) = F(Hz) / 7.5  →  Q = (xung/dt_s) / 7.5
    flowLpmN = (dN / dt_s) / 7.5f;
    flowLpmP = (dP / dt_s) / 7.5f;
    flowLpmK = (dK / dt_s) / 7.5f;

    lastFlowCalc = now;
}

// ================================================================
// XỬ LÝ LOGIC BƠM (gọi liên tục trong loop)
// ================================================================
void processDispensing() {
    if (!systemRunning) return;

    // Đọc tổng thể tích đã bơm của từng van
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE;
    float volP = pulseP * ML_PER_PULSE;
    float volK = pulseK * ML_PER_PULSE;
    interrupts();

    switch (currentPhase) {
        case 1:  // Đang bơm N
            if (volN >= targetN) {
                closeValve(1);
                Serial.printf("[✓] Pha N hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volN, targetN);
                if (targetP > 0) {
                    currentPhase = 2;
                    openValve(2, speedP);
                    Serial.println("[>] Chuyển sang pha P...");
                } else if (targetK > 0) {
                    currentPhase = 3;
                    openValve(3, speedK);
                    Serial.println("[>] Chuyển sang pha K...");
                } else {
                    currentPhase = 4;
                    systemRunning = false;
                    Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
                }
            }
            break;

        case 2:  // Đang bơm P
            if (volP >= targetP) {
                closeValve(2);
                Serial.printf("[✓] Pha P hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volP, targetP);
                if (targetK > 0) {
                    currentPhase = 3;
                    openValve(3, speedK);
                    Serial.println("[>] Chuyển sang pha K...");
                } else {
                    currentPhase = 4;
                    systemRunning = false;
                    Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
                }
            }
            break;

        case 3:  // Đang bơm K
            if (volK >= targetK) {
                closeValve(3);
                currentPhase  = 4;
                systemRunning = false;
                Serial.printf("[✓] Pha K hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volK, targetK);
                Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
            }
            break;
    }
}

// ================================================================
// PUBLISH TRẠNG THÁI LÊN MQTT
// ================================================================
void publishStatus() {
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE;
    float volP = pulseP * ML_PER_PULSE;
    float volK = pulseK * ML_PER_PULSE;
    interrupts();

    JsonDocument doc;
    doc["ts"]        = (uint32_t)millis();
    doc["running"]   = systemRunning;
    doc["phase"]     = currentPhase;
    doc["wifi_rssi"] = WiFi.RSSI();

    auto mkValve = [&](const char* key, float vol, float target,
                       float flow, int32_t steps, bool isOpen) {
        JsonObject v = doc["valves"][key].to<JsonObject>();
        v["open"]      = isOpen;
        v["steps"]     = steps;
        v["flow_lpm"]  = roundf(flow * 100.0f) / 100.0f;
        v["volume_ml"] = roundf(vol);
        v["target_ml"] = roundf(target);
        v["percent"]   = (target > 0) ? min(100.0f, vol / target * 100.0f) : 0.0f;
    };

    mkValve("N", volN, targetN, flowLpmN, posN, currentPhase == 1);
    mkValve("P", volP, targetP, flowLpmP, posP, currentPhase == 2);
    mkValve("K", volK, targetK, flowLpmK, posK, currentPhase == 3);

    doc["total_target_ml"] = targetN + targetP + targetK;
    doc["total_volume_ml"] = volN + volP + volK;

    char buffer[700];
    size_t len = serializeJson(doc, buffer);
    mqttClient.publish(TOPIC_STATUS, (uint8_t*)buffer, len, false);
}

// ================================================================
// SETUP
// ================================================================
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println(F("\n╔══════════════════════════════════════╗"));
    Serial.println(F("║  HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG   ║"));
    Serial.println(F("╚══════════════════════════════════════╝"));

    // LED trạng thái
    pinMode(STATUS_LED, OUTPUT);
    digitalWrite(STATUS_LED, LOW);

    // Khởi tạo chân stepper
    int stepperPins[] = {STEP_N, DIR_N, EN_N, STEP_P, DIR_P, EN_P, STEP_K, DIR_K, EN_K};
    for (int pin : stepperPins) pinMode(pin, OUTPUT);

    // Tắt tất cả driver (ENABLE = HIGH → disable)
    digitalWrite(EN_N, HIGH);
    digitalWrite(EN_P, HIGH);
    digitalWrite(EN_K, HIGH);

    // Khởi tạo cảm biến lưu lượng
    pinMode(FLOW_N, INPUT);
    pinMode(FLOW_P, INPUT);
    pinMode(FLOW_K, INPUT);
    attachInterrupt(digitalPinToInterrupt(FLOW_N), onFlowN, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_P), onFlowP, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_K), onFlowK, RISING);
    Serial.println(F("[OK] Cảm biến lưu lượng đã kích hoạt interrupt"));

    // Kết nối WiFi
    Serial.printf("[WiFi] Kết nối tới '%s'", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 40) {
        delay(500);
        Serial.print(".");
        tries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WiFi] ✓ Đã kết nối! IP: %s\n", WiFi.localIP().toString().c_str());
        digitalWrite(STATUS_LED, HIGH);
    } else {
        Serial.println(F("\n[WiFi] ✗ Không kết nối được! Kiểm tra SSID/Password"));
    }

    // Cấu hình MQTT
    mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(700);
    mqttClient.setKeepAlive(30);
    mqttClient.setSocketTimeout(10);

    lastFlowCalc = millis();
    Serial.println(F("[OK] Hệ thống sẵn sàng!\n"));
}

// ================================================================
// LOOP
// ================================================================
void loop() {
    // Kiểm tra WiFi
    if (WiFi.status() != WL_CONNECTED) {
        digitalWrite(STATUS_LED, LOW);
        delay(100);
        return;
    }

    // Duy trì kết nối MQTT
    if (!mqttClient.connected()) {
        mqttReconnect();
    }
    mqttClient.loop();

    unsigned long now = millis();

    // Tính lưu lượng mỗi 1 giây
    if (now - lastFlowCalc >= FLOW_CALC_INTERVAL) {
        calculateFlowRates();
    }

    // Xử lý logic bơm
    if (simMode && systemRunning) {
        // Chế độ ĐỒNG THỜI: vòng P-controller
        if (now - lastControlTime >= CONTROL_INTERVAL_MS) {
            controlSimultaneous();
            lastControlTime = now;
        }
    } else if (!simMode && systemRunning) {
        // Chế độ TUẦN TỰ
        processDispensing();
    }

    // Publish trạng thái về server
    if (now - lastPublish >= PUBLISH_INTERVAL) {
        publishStatus();
        lastPublish = now;
    }
}
