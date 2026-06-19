#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
// CẤU HÌNH WIFI & MQTT
const char* WIFI_SSID     = "huuducc";
const char* WIFI_PASSWORD = "190520044";
const char* MQTT_SERVER   = "broker.hivemq.com"; //Cloud MQTT
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";
const char* MQTT_PASS     = "";

#define DIR_N      13
#define STEP_N     14
#define EN_N       32

#define DIR_P      27
#define STEP_P     26
#define EN_P       22

#define DIR_K      25
#define STEP_K     33
#define EN_K       23

#define FLOW_N     16
#define FLOW_P     17
#define FLOW_K     18
#define FLOW_MAIN  19

#define PUMP_PIN   4
#define VALVE_PIN  5

#define STATUS_LED  2
#define STEPS_PER_REV   200
#define MICROSTEP       8

// Giới hạn step
#define MAX_OPEN_STEPS_N  14000
#define MAX_OPEN_STEPS_P  8500
#define MAX_OPEN_STEPS_K  9000
// speed step
#define STEP_DELAY_US   200 
 
// Hiệu chỉnh YF-S401
#define ML_PER_PULSE_N      0.21314f
#define ML_PER_PULSE_P      0.20298f
#define ML_PER_PULSE_K      0.20195f
#define ML_PER_PULSE_MAIN   44.35324f // Cảm biến DN32

// Chu kỳ publish và tính flow rate (ms)
#define PUBLISH_INTERVAL    200
#define FLOW_CALC_INTERVAL  200

// lưu lượng phân max
#define Q_MAX_LPM_N     0.588f
#define Q_MAX_LPM_P     0.633f
#define Q_MAX_LPM_K     0.582f

// tg đóng van 
#define SLOW_CLOSE_THRESHOLD_STEPS  200

// Cấu trúc và bảng tra cứu hiệu chuẩn số bước theo lưu lượng thực tế
struct CalibrationPoint {
    float flowLpm;  // Lưu lượng thực tế (L/phút)
    int32_t steps;  // Số bước mở tương ứng
};

// Bảng tra cứu Bồn A (N) - 20 điểm thực tế, scale 3-bồn (max 0.588 L/min @ 13600 steps)
const int NUM_POINTS_N = 20;
CalibrationPoint lutN[NUM_POINTS_N] = {
    {0.000f,     0},
    {0.112f,  1360},
    {0.143f,  2040},
    {0.286f,  2720},
    {0.370f,  3400},
    {0.430f,  4080},
    {0.490f,  4760},
    {0.520f,  5440},
    {0.535f,  6120},
    {0.546f,  6800},
    {0.551f,  7480},
    {0.556f,  8160},
    {0.560f,  8840},
    {0.564f,  9520},
    {0.568f, 10200},
    {0.572f, 10880},
    {0.576f, 11560},
    {0.580f, 12240},
    {0.584f, 12920},
    {0.588f, 13600},
};

// Bảng tra cứu Bồn B (P) - 20 điểm thực tế, scale 3-bồn (max 0.633 L/min @ 8500 steps)
const int NUM_POINTS_P = 20;
CalibrationPoint lutP[NUM_POINTS_P] = {
    {0.000f,    0},
    {0.230f,  850},
    {0.370f, 1275},
    {0.490f, 1700},
    {0.570f, 2125},
    {0.605f, 2550},
    {0.618f, 2975},
    {0.620f, 3400},
    {0.621f, 3825},
    {0.622f, 4250},
    {0.623f, 4675},
    {0.624f, 5100},
    {0.626f, 5525},
    {0.628f, 5950},
    {0.629f, 6375},
    {0.630f, 6800},
    {0.631f, 7225},
    {0.631f, 7650},
    {0.632f, 8075},
    {0.633f, 8500},
};

// Bảng tra cứu Bồn C (K) - 20 điểm thực tế, scale 3-bồn (max 0.582 L/min @ 9000 steps)
const int NUM_POINTS_K = 20;
CalibrationPoint lutK[NUM_POINTS_K] = {
    {0.000f,    0},
    {0.411f,  900},
    {0.454f, 1350},
    {0.540f, 1800},
    {0.547f, 2250},
    {0.552f, 2700},
    {0.556f, 3150},
    {0.559f, 3600},
    {0.561f, 4050},
    {0.563f, 4500},
    {0.565f, 4950},
    {0.567f, 5400},
    {0.569f, 5850},
    {0.571f, 6300},
    {0.574f, 6750},
    {0.576f, 7200},
    {0.578f, 7650},
    {0.579f, 8100},
    {0.580f, 8550},
    {0.582f, 9000},
};

// Hàm nội suy tuyến tính tìm số bước từ lưu lượng mục tiêu
int32_t getStepsFromFlow(float targetFlow, CalibrationPoint* lut, int numPoints) {
    if (targetFlow <= 0.0f) return 0;
    
    // Nếu vượt quá giới hạn tối đa
    if (targetFlow >= lut[numPoints - 1].flowLpm) {
        return lut[numPoints - 1].steps;
    }
    
    // Nếu nằm dưới điểm có dòng chảy ban đầu
    if (targetFlow < lut[0].flowLpm) {
        return (targetFlow / lut[0].flowLpm) * lut[0].steps;
    }
    
    // Nội suy giữa 2 điểm kề nhau
    for (int i = 0; i < numPoints - 1; i++) {
        if (targetFlow >= lut[i].flowLpm && targetFlow <= lut[i+1].flowLpm) {
            float ratio = (targetFlow - lut[i].flowLpm) / (lut[i+1].flowLpm - lut[i].flowLpm);
            return lut[i].steps + ratio * (lut[i+1].steps - lut[i].steps);
        }
    }
    return lut[numPoints - 1].steps;
}

//====================================================================================================================================================================================================================
// BIẾN TOÀN CỤC

// --- Bộ đếm xung cảm biến (PHẢI khai báo volatile vì dùng trong ISR) ---
volatile uint32_t pulseN = 0;
volatile uint32_t pulseP = 0;
volatile uint32_t pulseK = 0;
volatile uint32_t pulseMain = 0;

// Snapshot để tính flow rate
uint32_t snapPulseN = 0, snapPulseP = 0, snapPulseK = 0, snapPulseMain = 0;
float    flowLpmN = 0.0f, flowLpmP = 0.0f, flowLpmK = 0.0f, flowLpmMain = 0.0f;

// Cấu trúc cửa sổ trượt (sliding window) để tính lưu lượng phản hồi nhanh
#define FLOW_WINDOW_SIZE    5
uint32_t historyN[FLOW_WINDOW_SIZE] = {0};
uint32_t historyP[FLOW_WINDOW_SIZE] = {0};
uint32_t historyK[FLOW_WINDOW_SIZE] = {0};
uint32_t historyMain[FLOW_WINDOW_SIZE] = {0};
uint8_t flowWindowIdx = 0;
// Mục tiêu thể tích (mL)
float targetN = 0.0f, targetP = 0.0f, targetK = 0.0f;
// Phần trăm mở van (0-100) - dùng cho chế độ tuần tự
int speedN = 60, speedP = 60, speedK = 60;
// Vị trí hiện tại của van (số micro-bước từ vị trí đóng)
int32_t posN = 0, posP = 0, posK = 0;

// Các biến bảo vệ & self-learning
int32_t learnedMinN = 0, learnedMaxN = MAX_OPEN_STEPS_N;
int32_t learnedMinP = 0, learnedMaxP = MAX_OPEN_STEPS_P;
int32_t learnedMinK = 0, learnedMaxK = MAX_OPEN_STEPS_K;

int32_t lastSatPosN = 0, lastSatPosP = 0, lastSatPosK = 0;
float lastSatFlowN = 0.0f, lastSatFlowP = 0.0f, lastSatFlowK = 0.0f;

float compN = 0.0f, compP = 0.0f, compK = 0.0f; // Biến bù trừ PI tự động

bool monitoringN = false, monitoringP = false, monitoringK = false;
int extraCloseN = 0, extraCloseP = 0, extraCloseK = 0;

#define CONTROL_INTERVAL_MS 100

// ---- Biến chế độ ĐỒNG THỜI ----
bool simMode = false;                          // true = chế độ đồng thời đang chạy
float targetLpmN = 0.0f;                       // Lưu lượng mục tiêu van N (L/phút)
float targetLpmP = 0.0f;                       // Lưu lượng mục tiêu van P (L/phút)
float targetLpmK = 0.0f;                       // Lưu lượng mục tiêu van K (L/phút)
bool  doneN = false, doneP = false, doneK = false;  // Van đã đạt đủ lượng?

float targetTotalWaterL = 0.0f; // Tổng lượng nước mục tiêu (Lít)
bool dosingCompletedTimeRecorded = false; // true khi hoàn thành châm phân
float finalWaterTargetL = 0.0f;           // Thể tích nước đích sau khi cộng thêm lượng xả ống
unsigned long lastControlTime = 0;             // Thời điểm điều khiển cuối
// Trạng thái hệ thống
//   0   = Chờ (Idle)
//   4   = Hoàn thành
//   100 = Đồng thời đang chạy
bool systemRunning = false;
int  currentPhase  = 0;

// Thời điểm các sự kiện cuối
unsigned long lastPublish    = 0;
unsigned long lastFlowCalc   = 0;
unsigned long lastReconnectTry = 0;
unsigned long lastSerialLog  = 0;  // Thời điểm in Serial gần nhất
int serialLogCount = 0;            // Đếm số giây đã chạy

// Thời điểm bắt đầu chạy chu trình (ms) - dùng để tính elapsed time log
unsigned long runStartTime = 0;
String systemError = "";   // Mã lỗi hệ thống hiện tại

// MQTT Topics (Đã đổi để tránh bị trùng với người khác trên public broker)
const char* TOPIC_CMD    = "autofert_khoaluan2026/cmd";
const char* TOPIC_STATUS = "autofert_khoaluan2026/status";
// Clients
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

// NGẮT CẢM BIẾN LƯU LƯỢNG (ISR - Interrupt Service Routine)
void IRAM_ATTR onFlowN() { pulseN++; }
void IRAM_ATTR onFlowP() { pulseP++; }
void IRAM_ATTR onFlowK() { pulseK++; }
void IRAM_ATTR onFlowMain() { pulseMain++; }

//====================================================================================================================================================================================================================
// ĐIỀU KHIỂN ĐỘNG CƠ BƯỚC
// Di chuyển stepper motor một số bước chỉ định của van tương ứng (1 = N, 2 = P, 3 = K).
// steps > 0 → hướng mở van
// steps < 0 → hướng đóng van
void moveStepper(int valve, int steps) {
    if (steps == 0) return;
    uint8_t stepPin, dirPin, enPin;
    int32_t *posPtr = nullptr;
    int32_t stepMin = 0, stepMax = MAX_OPEN_STEPS_N;
    switch (valve) {
        case 1:
            stepPin = STEP_N; dirPin = DIR_N; enPin = EN_N;
            posPtr = &posN; stepMax = MAX_OPEN_STEPS_N;
            break;
        case 2:
            stepPin = STEP_P; dirPin = DIR_P; enPin = EN_P;
            posPtr = &posP; stepMax = MAX_OPEN_STEPS_P;
            break;
        case 3:
            stepPin = STEP_K; dirPin = DIR_K; enPin = EN_K;
            posPtr = &posK; stepMax = MAX_OPEN_STEPS_K;
            break;
        default: return;
    }
    digitalWrite(enPin, LOW);    // Cấp điện cho motor (ENABLE tích cực mức THẤP cho TB6600 Common Cathode)
    delayMicroseconds(100);     // Tăng từ 2us lên 100us để bảo đảm driver/optocoupler đã mở hoàn toàn

    bool opening = (steps > 0);
    if (opening) {
        digitalWrite(dirPin, HIGH);   // Chiều mở
    } else {
        digitalWrite(dirPin, LOW);    // Chiều đóng
        steps = -steps;
    }
    delayMicroseconds(2);
    for (int i = 0; i < steps; i++) {
        // Kiểm tra giới hạn an toàn bước trước khi di chuyển thực tế
        if (posPtr) {
            if (opening) {
                if (*posPtr >= stepMax) {
                    Serial.printf("[VAN %d] Kich gioi han MAX (%d buoc)!\n", valve, stepMax);
                    break;
                }
                (*posPtr)++;
            } else {
                if (*posPtr <= stepMin) {
                    Serial.printf("[VAN %d] Kich gioi han MIN (%d buoc)!\n", valve, stepMin);
                    break;
                }
                (*posPtr)--;
            }
        }
        // Tính toán độ trễ động (Dynamic step delay) để giảm tốc khi đóng gần về 0
        uint32_t currentDelay = STEP_DELAY_US;
        if (!opening && posPtr && *posPtr < SLOW_CLOSE_THRESHOLD_STEPS) {
            // Càng gần vị trí 0, tốc độ càng chậm lại (delay tăng từ 500us lên tối đa 2000us)
            float slowFactor = (float)(SLOW_CLOSE_THRESHOLD_STEPS - *posPtr) / SLOW_CLOSE_THRESHOLD_STEPS;
            currentDelay = STEP_DELAY_US + (uint32_t)(slowFactor * 1500.0f);
        }
        digitalWrite(stepPin, HIGH);
        delayMicroseconds(currentDelay);
        digitalWrite(stepPin, LOW);
        delayMicroseconds(currentDelay);
        // Cho phép MQTT xử lý giữa chừng để không bị timeout
        if ((i & 0xFF) == 0xFF) {
            mqttClient.loop();
        }
    }
}

//====================================================================================================================================================================================================================
// Điều khiển đồng thời 3 động cơ bước quay cùng một lúc bằng phát xung xen kẽ
void moveSteppersSimultaneous(int stepsN, int stepsP, int stepsK) {
    if (stepsN == 0 && stepsP == 0 && stepsK == 0) return;
    // 1. Kích hoạt driver (ENABLE tích cực mức CAO) và cài đặt chiều quay (DIR)
    if (stepsN != 0) {
        digitalWrite(EN_N, LOW);
        digitalWrite(DIR_N, stepsN > 0 ? HIGH : LOW);
    }
    if (stepsP != 0) {
        digitalWrite(EN_P, LOW);
        digitalWrite(DIR_P, stepsP > 0 ? HIGH : LOW);
    }
    if (stepsK != 0) {
        digitalWrite(EN_K, LOW);
        digitalWrite(DIR_K, stepsK > 0 ? HIGH : LOW);
    }
    delayMicroseconds(100); // Chờ driver ổn định
    int absN = abs(stepsN);
    int absP = abs(stepsP);
    int absK = abs(stepsK);
    int maxSteps = max(absN, max(absP, absK));
    
    // Nếu tất cả các van đều đang đóng (quay về 0), sử dụng tốc độ cực nhanh để ngắt dòng chảy
    bool isClosingOnly = (stepsN <= 0 && stepsP <= 0 && stepsK <= 0);
    // 200us là quá nhanh đối với động cơ bước không có gia tốc, gây trượt/kẹt cứng (stall). 
    // Giảm xuống một tốc độ an toàn hơn. 300us là đủ an toàn và nhanh hơn nhiều so với 800us.
    uint32_t currentDelay = isClosingOnly ? 300 : STEP_DELAY_US;

    for (int i = 0; i < maxSteps; i++) {
        // [CẢI TIẾN QUAN TRỌNG]: Kiểm tra liên tục xem các van khác có đạt mục tiêu trong lúc hàm đang block không!
        if (!doneN && targetN > 0 && (pulseN * ML_PER_PULSE_N) >= targetN) {
            doneN = true;
            stepsN = -posN; absN = abs(stepsN);
            maxSteps = max(absN, max(absP, absK));
            digitalWrite(DIR_N, LOW);
            digitalWrite(EN_N, LOW);
            Serial.printf("\n[SIM] Van N dat muc tieu (%.0f mL) TRONG KHI xoay! Bat dau dong ngay!\n", (float)(pulseN * ML_PER_PULSE_N));
        }
        if (!doneP && targetP > 0 && (pulseP * ML_PER_PULSE_P) >= targetP) {
            doneP = true;
            stepsP = -posP; absP = abs(stepsP);
            maxSteps = max(absN, max(absP, absK));
            digitalWrite(DIR_P, LOW);
            digitalWrite(EN_P, LOW);
            Serial.printf("\n[SIM] Van P dat muc tieu (%.0f mL) TRONG KHI xoay! Bat dau dong ngay!\n", (float)(pulseP * ML_PER_PULSE_P));
        }
        if (!doneK && targetK > 0 && (pulseK * ML_PER_PULSE_K) >= targetK) {
            doneK = true;
            stepsK = -posK; absK = abs(stepsK);
            maxSteps = max(absN, max(absP, absK));
            digitalWrite(DIR_K, LOW);
            digitalWrite(EN_K, LOW);
            Serial.printf("\n[SIM] Van K dat muc tieu (%.0f mL) TRONG KHI xoay! Bat dau dong ngay!\n", (float)(pulseK * ML_PER_PULSE_K));
        }

        // Kiểm tra an toàn giới hạn cơ khí cho từng động cơ
        bool stepN_active = (i < absN) && (stepsN > 0 ? (posN < learnedMaxN) : (posN > learnedMinN));
        bool stepP_active = (i < absP) && (stepsP > 0 ? (posP < learnedMaxP) : (posP > learnedMinP));
        bool stepK_active = (i < absK) && (stepsK > 0 ? (posK < learnedMaxK) : (posK > learnedMinK));
        
        if (!stepN_active && !stepP_active && !stepK_active) break;
        
        // Kích hoạt sườn lên (Rising edge)
        if (stepN_active) digitalWrite(STEP_N, HIGH);
        if (stepP_active) digitalWrite(STEP_P, HIGH);
        if (stepK_active) digitalWrite(STEP_K, HIGH);
        delayMicroseconds(currentDelay);
        
        // Kích hoạt sườn xuống (Falling edge) và cập nhật vị trí
        if (stepN_active) {
            digitalWrite(STEP_N, LOW);
            posN += (stepsN > 0 ? 1 : -1);
        }
        if (stepP_active) {
            digitalWrite(STEP_P, LOW);
            posP += (stepsP > 0 ? 1 : -1);
        }
        if (stepK_active) {
            digitalWrite(STEP_K, LOW);
            posK += (stepsK > 0 ? 1 : -1);
        }
        delayMicroseconds(currentDelay);

        // Tránh watchdog timeout
        if ((i & 0xFF) == 0xFF) {
            mqttClient.loop();
        }
    }
}

//====================================================================================================================================================================================================================
// Mở van đến phần trăm mong muốn (0% = đóng, 100% = mở hoàn toàn).
void openValve(int valve, int percent) {
    int maxSteps = MAX_OPEN_STEPS_N;
    switch (valve) {
        case 1: maxSteps = MAX_OPEN_STEPS_N; break;
        case 2: maxSteps = MAX_OPEN_STEPS_P; break;
        case 3: maxSteps = MAX_OPEN_STEPS_K; break;
    }
    int targetSteps = (maxSteps * constrain(percent, 0, 100)) / 100;
    int32_t currentPos = 0;
    switch (valve) {
        case 1: currentPos = posN; break;
        case 2: currentPos = posP; break;
        case 3: currentPos = posK; break;
    }
    int delta = targetSteps - currentPos;
    Serial.printf("[VAN %c] Mo %d%% -> di chuyen %d buoc (Viri hientai: %d, Target: %d)\n",
                  (valve == 1 ? 'N' : (valve == 2 ? 'P' : 'K')), percent, delta, currentPos, targetSteps);
    moveStepper(valve, delta);
}

//====================================================================================================================================================================================================================
//Đóng hoàn toàn một van và tắt driver để tiết kiệm điện.
void closeValve(int valve) {
    openValve(valve, 0);
    switch (valve) {
        case 1: digitalWrite(EN_N, HIGH); break;
        case 2: digitalWrite(EN_P, HIGH); break;
        case 3: digitalWrite(EN_K, HIGH); break;
    }
}

//====================================================================================================================================================================================================================
// Dừng khẩn cấp: Tắt toàn bộ thiết bị ngay lập tức (không xoay động cơ bước về 0).
void emergencyStop() {
    Serial.println("\n!!! DỪNG KHẨN CẤP - Ngắt toàn bộ thiết bị ngay lập tức !!!\n");
    systemRunning = false;
    currentPhase  = 0;
    simMode       = false;
    doneN = doneP = doneK = false;
    monitoringN = monitoringP = monitoringK = false;
    extraCloseN = extraCloseP = extraCloseK = 0;
    
    // Tắt Bơm và Van điện từ chính ngay lập tức để ngắt dòng chảy
    digitalWrite(PUMP_PIN, LOW);
    digitalWrite(VALVE_PIN, LOW);
    
    // Đóng các van kim về vị trí 0 để chống rò rỉ dung dịch phân bón
    if (posN > 0) closeValve(1);
    else digitalWrite(EN_N, HIGH);
    
    if (posP > 0) closeValve(2);
    else digitalWrite(EN_P, HIGH);
    
    if (posK > 0) closeValve(3);
    else digitalWrite(EN_K, HIGH);
}

//====================================================================================================================================================================================================================
// MQTT CALLBACK - Nhận lệnh từ server
// ĐIỀU KHIỂN TỈ LỆ - CHẠY ĐỒNG THỜI (P-Controller)
// Gọi trong loop() mỗi CONTROL_INTERVAL_MS ms
void controlSimultaneous() {
    unsigned long now = millis();
    if (now - lastControlTime < CONTROL_INTERVAL_MS) return;
    lastControlTime = now;

    // 1. KIỂM TRA ĐIỀU KIỆN KẾT THÚC CHU TRÌNH TOÀN BỘ (Có xả ống 10% cuối chu trình sau châm phân)
    if (systemRunning) {
        float currentVolL = (pulseMain * ML_PER_PULSE_MAIN) / 1000.0f;
        bool dosingDone = (doneN || targetN <= 0) && (doneP || targetP <= 0) && (doneK || targetK <= 0);
        
        if (dosingDone && !dosingCompletedTimeRecorded) {
            dosingCompletedTimeRecorded = true;
            finalWaterTargetL = targetTotalWaterL; // Không cộng thêm nước để giữ tỉ lệ 1/100
            Serial.printf("[XẢ ỐNG] Châm phân hoàn thành. Nước hiện tại: %.2f L. Thiết lập đích xả ống: %.2f L\n", 
                          currentVolL, finalWaterTargetL);
        }

        bool waterDone = false;
        if (dosingCompletedTimeRecorded) {
            waterDone = (currentVolL >= finalWaterTargetL);
        } else {
            waterDone = (targetTotalWaterL <= 0.0f || currentVolL >= targetTotalWaterL);
        }
        
        if (waterDone) {
            if (!dosingDone) {
                Serial.printf("[CẢNH BÁO] Đạt đủ nước (%.1f L) nhưng phân bón CHƯA xong! Bắt buộc dừng hệ thống.\n", currentVolL);
            } else {
                Serial.printf("[KẾT THÚC] Đã đạt đủ nước chính (%.1f L / Đích xả ống: %.1f L). Tắt toàn bộ hệ thống!\n", currentVolL, finalWaterTargetL);
            }
            emergencyStop();
            digitalWrite(PUMP_PIN, LOW);
            digitalWrite(VALVE_PIN, LOW);
            systemRunning = false;
            currentPhase = 4; // Phase 4 = Completed
            publishStatus(); // Gửi báo cáo MQTT ngay lập tức để Node.js lưu DataBase
            return;
        }
    }

    // Chỉ thực thi đọc lưu lượng khi simMode = true (Tức là chưa châm xong phân)
    if (!simMode) return;

    // Đọc thể tích tích lũy
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE_N;
    float volP = pulseP * ML_PER_PULSE_P;
    float volK = pulseK * ML_PER_PULSE_K;
    interrupts();

    // --- ĐIỀU KHIỂN OPEN-LOOP BẰNG BẢNG TRA CỨU ---
    // Loại bỏ thuật toán t_max cũ, ưu tiên bám sát lưu lượng mục tiêu (targetLpm) do Server gửi xuống
    // để giữ tỷ lệ 1/100 (0.8 L/phút) chuẩn xác.

    float dynTargetLpmN = targetLpmN;
    float dynTargetLpmP = targetLpmP;
    float dynTargetLpmK = targetLpmK;

    int adjN = 0, adjP = 0, adjK = 0;
    // --- Van N ---
    if (!doneN && targetN > 0) {
        // Tính độ trễ đóng van và lượng dư (Early Cutoff) + thêm 5mL bù trừ quán tính nước
        float t_close_N = posN * (2.0f * STEP_DELAY_US) / 1000000.0f; 
        float overshoot_N = (flowLpmN / 2.0f) * (t_close_N / 60.0f) * 1000.0f + 5.0f; 
        
        if (volN >= targetN - overshoot_N) {
            adjN = -posN; // Đóng van
            doneN = true;
            bool otherDone = (doneP || targetP <= 0) && (doneK || targetK <= 0);
            if (otherDone) {
                Serial.printf("[SIM✓] Van N đủ lượng. Dừng hệ thống ngay lập tức.\n");
            } else {
                Serial.printf("[SIM✓] Van N ngắt sớm (Overshoot: %.1f mL).\n", overshoot_N);
            }
            digitalWrite(EN_N, HIGH); // Tắt động cơ ngay lập tức
        } else {
            // Không giảm tốc độ khi gần đích để theo kịp lượng nước
            float currentDynTargetN = dynTargetLpmN;
            int32_t basePosN = getStepsFromFlow(currentDynTargetN, lutN, NUM_POINTS_N);
            
            // PI Controller tự bù trừ sai lệch của bảng tra cứu
            float errorN = currentDynTargetN - flowLpmN;
            if (abs(errorN) > currentDynTargetN * 0.05f) { // Vùng chết 5%
                compN += errorN * 100.0f; // Ki = 100
            }
            compN = constrain(compN, -3000, 4000); // Giới hạn an toàn
            
            int32_t targetPosN = basePosN + (int32_t)compN;
            targetPosN = constrain(targetPosN, 0, MAX_OPEN_STEPS_N);
            if (targetPosN != posN) {
                adjN = targetPosN - posN;
            }
        }
    }

    // --- Van P ---
    if (!doneP && targetP > 0) {
        float t_close_P = posP * (2.0f * STEP_DELAY_US) / 1000000.0f; 
        float overshoot_P = (flowLpmP / 2.0f) * (t_close_P / 60.0f) * 1000.0f + 5.0f; 
        
        if (volP >= targetP - overshoot_P) {
            adjP = -posP; 
            doneP = true;
            bool otherDone = (doneN || targetN <= 0) && (doneK || targetK <= 0);
            if (otherDone) {
                Serial.printf("[SIM✓] Van P đủ lượng. Dừng hệ thống ngay lập tức.\n");
            } else {
                Serial.printf("[SIM✓] Van P ngắt sớm (Overshoot: %.1f mL).\n", overshoot_P);
            }
            digitalWrite(EN_P, HIGH);
        } else {
            float currentDynTargetP = dynTargetLpmP;
            int32_t basePosP = getStepsFromFlow(currentDynTargetP, lutP, NUM_POINTS_P);
            
            float errorP = currentDynTargetP - flowLpmP;
            if (abs(errorP) > currentDynTargetP * 0.05f) {
                compP += errorP * 100.0f;
            }
            compP = constrain(compP, -3000, 4000);
            
            int32_t targetPosP = basePosP + (int32_t)compP;
            targetPosP = constrain(targetPosP, 0, MAX_OPEN_STEPS_P);
            if (targetPosP != posP) {
                adjP = targetPosP - posP;
            }
        }
    }

    // --- Van K ---
    if (!doneK && targetK > 0) {
        float t_close_K = posK * (2.0f * STEP_DELAY_US) / 1000000.0f; 
        float overshoot_K = (flowLpmK / 2.0f) * (t_close_K / 60.0f) * 1000.0f + 5.0f; 
        
        if (volK >= targetK - overshoot_K) {
            adjK = -posK; 
            doneK = true;
            bool otherDone = (doneN || targetN <= 0) && (doneP || targetP <= 0);
            if (otherDone) {
                Serial.printf("[SIM✓] Van K đủ lượng. Dừng hệ thống ngay lập tức.\n");
            } else {
                Serial.printf("[SIM✓] Van K ngắt sớm (Overshoot: %.1f mL).\n", overshoot_K);
            }
            digitalWrite(EN_K, HIGH);
        } else {
            float currentDynTargetK = dynTargetLpmK;
            int32_t basePosK = getStepsFromFlow(currentDynTargetK, lutK, NUM_POINTS_K);
            
            float errorK = currentDynTargetK - flowLpmK;
            if (abs(errorK) > currentDynTargetK * 0.05f) {
                compK += errorK * 100.0f;
            }
            compK = constrain(compK, -3000, 4000);
            
            int32_t targetPosK = basePosK + (int32_t)compK;
            targetPosK = constrain(targetPosK, 0, MAX_OPEN_STEPS_K);
            if (targetPosK != posK) {
                adjK = targetPosK - posK;
            }
        }
    }

    // 4. Kích hoạt phát xung quay van đồng thời bằng phương án xen kẽ
    if (adjN != 0 || adjP != 0 || adjK != 0) {
        moveSteppersSimultaneous(adjN, adjP, adjK);
        if (adjN != 0) Serial.printf("[N] Flow=%.3f (Tgt=%.3f) → Pos=%d steps\n", flowLpmN, dynTargetLpmN, posN);
        if (adjP != 0) Serial.printf("[P] Flow=%.3f (Tgt=%.3f) → Pos=%d steps\n", flowLpmP, dynTargetLpmP, posP);
        if (adjK != 0) Serial.printf("[K] Flow=%.3f (Tgt=%.3f) → Pos=%d steps\n", flowLpmK, dynTargetLpmK, posK);
    }
    // Kiểm tra hoàn thành tất cả van (bơm tắt ngay khi tất cả van đạt đủ lượng châm)
    bool allDosingDone = (doneN || targetN <= 0) && (doneP || targetP <= 0) && (doneK || targetK <= 0);
    if (allDosingDone) {
        // Dừng chế độ châm phân (Phase 2), chuyển sang chờ xả ống (Phase 3 do Server điều khiển)
        simMode       = false;
        
        // Cố tình GIỮ NGUYÊN trạng thái Bơm và Van điện từ, không tắt!
        // digitalWrite(PUMP_PIN, LOW);
        // digitalWrite(VALVE_PIN, LOW);
        // systemRunning = false;

        
        // Tắt giám sát rò rỉ và ngắt điện driver của tất cả van
        monitoringN = false;
        monitoringP = false;
        monitoringK = false;
        
        posN = 0; learnedMinN = 0; digitalWrite(EN_N, HIGH);
        posP = 0; learnedMinP = 0; digitalWrite(EN_P, HIGH);
        posK = 0; learnedMinK = 0; digitalWrite(EN_K, HIGH);
        
        Serial.println("[SIM✓✓] Hoàn thành châm phân (Phase 2)! Máy bơm vẫn tiếp tục chạy xả ống (Phase 3)...");
    }

    // (Thể tích nước tổng và điều kiện hoàn thành toàn bộ chu trình hiện được kiểm tra ở đầu hàm để tránh lỗi bỏ qua khi simMode dừng)
}

//====================================================================================================================================================================================================================
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
    
    // ---- Lệnh KHỞI ĐỘNG PHA TRỘN ĐỒNG THỜI (Hỗ trợ tương thích ngược cho start và start_seq) ----
    if (strcmp(cmd, "start_sim") == 0 || strcmp(cmd, "start_seq") == 0 || strcmp(cmd, "start") == 0) {
        if (systemRunning) { Serial.println("[!] Hệ thống đang chạy. Bỏ qua lệnh start."); return; }
        targetN    = doc["recipe"]["N"]["target_ml"] | 0.0f;
        targetP    = doc["recipe"]["P"]["target_ml"] | 0.0f;
        targetK    = doc["recipe"]["K"]["target_ml"] | 0.0f;
        
        targetLpmN = doc["recipe"]["N"]["target_lpm"] | 0.0f;
        if (targetLpmN <= 0.0f && targetN > 0.0f) {
            targetLpmN = (targetN / 1000.0f) / 1.0f; // Mặc định châm trong 1 phút
            if (targetLpmN < 0.1f) targetLpmN = 0.1f;
        }
        
        targetLpmP = doc["recipe"]["P"]["target_lpm"] | 0.0f;
        if (targetLpmP <= 0.0f && targetP > 0.0f) {
            targetLpmP = (targetP / 1000.0f) / 1.0f;
            if (targetLpmP < 0.1f) targetLpmP = 0.1f;
        }
        
        targetLpmK = doc["recipe"]["K"]["target_lpm"] | 0.0f;
        if (targetLpmK <= 0.0f && targetK > 0.0f) {
            targetLpmK = (targetK / 1000.0f) / 1.0f;
            if (targetLpmK < 0.1f) targetLpmK = 0.1f;
        }

        // Đọc tổng lượng nước mục tiêu (từ Server)
        float total_water_l = doc["total_water_l"] | 0.0f;
        targetTotalWaterL = total_water_l;

        // Đóng chặt các van về 0 trước khi khởi động phiên mới để tránh sai lệch cơ khí
        if (posN > 0) {
            Serial.printf("[INIT] Đang đóng van N (%d bước) về vị trí gốc...\n", posN);
            closeValve(1);
        }
        if (posP > 0) {
            Serial.printf("[INIT] Đang đóng van P (%d bước) về vị trí gốc...\n", posP);
            closeValve(2);
        }
        if (posK > 0) {
            Serial.printf("[INIT] Đang đóng van K (%d bước) về vị trí gốc...\n", posK);
            closeValve(3);
        }

        // Reset vị trí về 0 nhưng sau đó sẽ chủ động mở nhanh ban đầu
        posN = 0;
        posP = 0;
        posK = 0;

        // Reset các giới hạn an toàn tự học về mặc định cho chu kỳ mới
        learnedMinN = 0; learnedMaxN = MAX_OPEN_STEPS_N;
        learnedMinP = 0; learnedMaxP = MAX_OPEN_STEPS_P;
        learnedMinK = 0; learnedMaxK = MAX_OPEN_STEPS_K;

        // Reset các mốc học bão hòa cho chu kỳ mới
        lastSatPosN = 0; lastSatPosP = 0; lastSatPosK = 0;
        lastSatFlowN = 0.0f; lastSatFlowP = 0.0f; lastSatFlowK = 0.0f;
        // Reset pulse counters và state
        noInterrupts(); pulseN = pulseP = pulseK = pulseMain = 0; interrupts();
        snapPulseN = snapPulseP = snapPulseK = snapPulseMain = 0;
        // Reset cửa sổ trượt
        memset(historyN, 0, sizeof(historyN));
        memset(historyP, 0, sizeof(historyP));
        memset(historyK, 0, sizeof(historyK));
        memset(historyMain, 0, sizeof(historyMain));
        flowWindowIdx = 0;
        doneN = doneP = doneK = false;
        dosingCompletedTimeRecorded = false;
        finalWaterTargetL = 0.0f;
        monitoringN = monitoringP = monitoringK = false;
        extraCloseN = extraCloseP = extraCloseK = 0;
        
        compN = 0.0f; compP = 0.0f; compK = 0.0f; // Reset bù trừ PI
        
        // Đã loại bỏ các biến PID cũ
        Serial.printf("[SIM] N=%.0fmL@%.2fL/m | P=%.0fmL@%.2fL/m | K=%.0fmL@%.2fL/m\n",
                       targetN, targetLpmN,
                       targetP, targetLpmP,
                       targetK, targetLpmK);
        simMode = true;
        systemRunning = true;
        currentPhase  = 100;  // 100 = chế độ đồng thời
        systemError = "";      
        // Bật Van chính → bật bơm
        if (targetN > 0 || targetP > 0 || targetK > 0 || targetTotalWaterL > 0.0f) {
            // Bước 1: Mở van điện từ, nước từ bồn chảy tự do vào bơm
            Serial.println("[SIM] Bước 1: Mở van cấp nước từ bồn (chờ 10 giây nước điền đầy bơm)...");
            digitalWrite(VALVE_PIN, HIGH);
            delay(10000); // Đợi 10 giây để nước từ bồn điền đầy đường ống và buồng bơm

            // Bước 2: Bật bơm chính thức (van cơ đã được mồi sẵn)
            Serial.println("[SIM] Bước 2: Khởi động bơm chính...");
            digitalWrite(PUMP_PIN, HIGH);
            delay(1000);  // Đợi 1 giây cho dòng khởi động ổn định trước khi bắt đầu vòng điều khiển hồi tiếp
            // Mở nhanh ban đầu đồng thời theo bảng tra cứu vị trí ứng với lưu lượng mục tiêu
            int initN = targetN > 0 ? getStepsFromFlow(targetLpmN, lutN, NUM_POINTS_N) : 0;
            int initP = targetP > 0 ? getStepsFromFlow(targetLpmP, lutP, NUM_POINTS_P) : 0;
            int initK = targetK > 0 ? getStepsFromFlow(targetLpmK, lutK, NUM_POINTS_K) : 0;
            if (initN > 0 || initP > 0 || initK > 0) {
                moveSteppersSimultaneous(initN, initP, initK);
            }
        }       
        lastControlTime = millis();
        runStartTime = millis();        
        Serial.println("[SIM] Tất cả van đã mở - vòng lặp điều khiển bắt đầu!");
    }
    // ---- Lệnh DỪNG ----
    else if (strcmp(cmd, "stop") == 0) {
        emergencyStop();
        // Tắt luôn bơm và van nếu đang bật thủ công
        digitalWrite(PUMP_PIN, LOW);
        digitalWrite(VALVE_PIN, LOW);
    }
    // ---- Lệnh VỀ HOME (đặt lại vị trí gốc) ----
    else if (strcmp(cmd, "home") == 0) {
        if (!systemRunning) {
            auto smartHome = [](int valve, int32_t &pos, uint8_t enPin) {
                if (pos > 0) {
                    // Nếu van đã ghi nhận vị trí mở, đóng van chính xác về 0
                    closeValve(valve);
                } else {
                    // Nếu van đang ở 0, siết nhẹ thêm 200 bước để đảm bảo khít hoàn toàn
                    digitalWrite(enPin, LOW);
                    delayMicroseconds(2);
                    moveStepper(valve, -200);
                    pos = 0;
                    digitalWrite(enPin, HIGH); // Tắt driver (ngắt điện)
                }
            };
            smartHome(1, posN, EN_N);
            smartHome(2, posP, EN_P);
            smartHome(3, posK, EN_K);
            Serial.println("[HOME] Đã reset động cơ về vị trí gốc an toàn.");
        }
    }
    // ---- Lệnh RESET THỂ TÍCH TỔNG ĐƯỜNG ỐNG CHÍNH ----
    else if (strcmp(cmd, "reset_main") == 0) {
        noInterrupts();
        pulseMain = 0;
        snapPulseMain = 0;
        interrupts();
        flowLpmMain = 0.0f;
        Serial.println("[RESET] Đã reset thể tích đường ống chính về 0.");
        publishStatus();
    }
    // ---- Lệnh ĐIỀU KHIỂN THỦ CÔNG (Bơm, Van điện từ) ----
    else if (strcmp(cmd, "manual") == 0) {
        const char* device = doc["device"];
        bool state = doc["state"];
        if (device) {
            if (strcmp(device, "pump") == 0) {
                digitalWrite(PUMP_PIN, state ? HIGH : LOW);
                Serial.printf("[MANUAL] Bơm nước: %s\n", state ? "BẬT" : "TẮT");
            } else if (strcmp(device, "main_valve") == 0) {
                digitalWrite(VALVE_PIN, state ? HIGH : LOW);
                Serial.printf("[MANUAL] Van chính: %s\n", state ? "BẬT" : "TẮT");
            }
        }
    }
    // ---- Lệnh KIỂM TRA ĐỘNG CƠ BƯỚC (Manual) ----
    else if (strcmp(cmd, "stepper") == 0) {
        const char* type = doc["type"];
        int steps = doc["steps"] | 0;
        if (type && steps > 0) {
            if (strcmp(type, "N") == 0) {
                moveStepper(1, steps);
            } else if (strcmp(type, "P") == 0) {
                moveStepper(2, steps);
            } else if (strcmp(type, "K") == 0) {
                moveStepper(3, steps);
            }
            Serial.printf("[MANUAL] Test stepper %s: %d bước (Vị trí mới: N=%d, P=%d, K=%d)\n", 
                          type, steps, posN, posP, posK);
        }
    }
}

//====================================================================================================================================================================================================================

//====================================================================================================================================================================================================================
// TÍNH LƯU LƯỢNG (L/phút)
void calculateFlowRates() {
    unsigned long now = millis();
    float dt_s = (now - lastFlowCalc) / 1000.0f;
    if (dt_s < 0.01f) return;
// Lấy snapshot xung, tắt interrupt tạm thời
    noInterrupts();
    uint32_t pN = pulseN;
    uint32_t pP = pulseP;
    uint32_t pK = pulseK;
    uint32_t pMain = pulseMain;
    interrupts();
    uint32_t dN = pN - snapPulseN;
    uint32_t dP = pP - snapPulseP;
    uint32_t dK = pK - snapPulseK;
    uint32_t dMain = pMain - snapPulseMain;
    snapPulseN = pN;
    snapPulseP = pP;
    snapPulseK = pK;
    snapPulseMain = pMain;

    // Đẩy giá trị mới vào cửa sổ trượt
    historyN[flowWindowIdx] = dN;
    historyP[flowWindowIdx] = dP;
    historyK[flowWindowIdx] = dK;
    historyMain[flowWindowIdx] = dMain;
    
    flowWindowIdx = (flowWindowIdx + 1) % FLOW_WINDOW_SIZE;

    // Tính tổng số xung trong cửa sổ trượt (tương đương 1 giây gần nhất)
    uint32_t sumN = 0, sumP = 0, sumK = 0, sumMain = 0;
    for (int i = 0; i < FLOW_WINDOW_SIZE; i++) {
        sumN += historyN[i];
        sumP += historyP[i];
        sumK += historyK[i];
        sumMain += historyMain[i];
    }

    // Tính lưu lượng thực tế theo hệ số hiệu chuẩn đã lưu (dựa trên tổng 1 giây gần nhất): Q(L/min) = sumPulse * ML_PER_PULSE * 0.06 / 1.0f
    flowLpmN = sumN * ML_PER_PULSE_N * 0.06f; 
    flowLpmP = sumP * ML_PER_PULSE_P * 0.06f; 
    flowLpmK = sumK * ML_PER_PULSE_K * 0.06f; 
    flowLpmMain = sumMain * ML_PER_PULSE_MAIN * 0.06f; // Cảm biến DN32 ống chính (Q = sum * ML_PER_PULSE * 0.06)

    lastFlowCalc = now;


    // --- IN LOG CHU KỲ RA SERIAL MONITOR (mỗi 1 giây) ---
    if (systemRunning && (now - lastSerialLog >= 1000)) {
        lastSerialLog = now;
        serialLogCount++;
        unsigned long elapsed = (now - runStartTime) / 1000;
        
        // Tính phần trăm hoàn thành
        float pctN = (targetN > 0) ? min(100.0f, (pulseN * ML_PER_PULSE_N) / targetN * 100.0f) : 0.0f;
        float pctP = (targetP > 0) ? min(100.0f, (pulseP * ML_PER_PULSE_P) / targetP * 100.0f) : 0.0f;
        float pctK = (targetK > 0) ? min(100.0f, (pulseK * ML_PER_PULSE_K) / targetK * 100.0f) : 0.0f;
        
        // In header mỗi 10 dòng
        if (serialLogCount == 1 || serialLogCount % 10 == 1) {
            Serial.println("\n[SENSOR LOG] =====================================================================");
            Serial.println("[SENSOR LOG] T(s) | Chan |  Flow(LPM) | Vol(mL) | Target(mL) | Steps  | Done");
            Serial.println("[SENSOR LOG] -------+------+------------+---------+------------+--------+-----");
        }
        
        // In dữ liệu từng bồn
        Serial.printf("[SENSOR LOG] %4lus | N    | %8.3f  | %7.1f | %10.0f | %6d | %s\n",
            elapsed, flowLpmN, pulseN * ML_PER_PULSE_N, targetN, posN, doneN ? "DONE" : "RUN");
        Serial.printf("[SENSOR LOG] %4lus | P    | %8.3f  | %7.1f | %10.0f | %6d | %s\n",
            elapsed, flowLpmP, pulseP * ML_PER_PULSE_P, targetP, posP, doneP ? "DONE" : "RUN");
        Serial.printf("[SENSOR LOG] %4lus | K    | %8.3f  | %7.1f | %10.0f | %6d | %s\n",
            elapsed, flowLpmK, pulseK * ML_PER_PULSE_K, targetK, posK, doneK ? "DONE" : "RUN");
        Serial.printf("[SENSOR LOG] %4lus | MAIN | %8.3f  | %7.1f | %10.1f | ------ | ---\n",
            elapsed, flowLpmMain, pulseMain * ML_PER_PULSE_MAIN, targetTotalWaterL * 1000.0f);
        Serial.println("[SENSOR LOG] -------+------+------------+---------+------------+--------+-----");
    }
    // Reset đếm khi hệ thống dừng
    if (!systemRunning) { serialLogCount = 0; lastSerialLog = 0; }
}

//====================================================================================================================================================================================================================
// ĐÓNG CHẶT VAN HỒI TIẾP (CLOSED-LOOP CLOSED VALVE FEEDBACK CORRECTION)
// Di chuyển động cơ bước thêm cho đến khi cảm biến lưu lượng thực sự báo 0 L/phút
void forceCloseValve(int valve) {
    Serial.printf("[FORCE CLOSE] Bat dau dong chat van %d...\n", valve);   
    // 1. Di chuyển về vị trí 0
    openValve(valve, 0);    
    
    uint8_t enPin;
    switch (valve) {
        case 1: enPin = EN_N; break;
        case 2: enPin = EN_P; break;
        case 3: enPin = EN_K; break;
        default: return;
    }   
    
    // 2. Hoan thanh: Tat driver (ENABLE = HIGH) de bao ve dong co, giam nhiet do
    digitalWrite(enPin, HIGH);
    Serial.printf("[FORCE CLOSE] Van %d da duoc dua ve 0 va ngat dien dong co.\n", valve);
}

//====================================================================================================================================================================================================================
// KẾT NỐI MQTT
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

//====================================================================================================================================================================================================================
// PUBLISH TRẠNG THÁI LÊN MQTT
void publishStatus() {
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE_N;
    float volP = pulseP * ML_PER_PULSE_P;
    float volK = pulseK * ML_PER_PULSE_K;
    float volMain = pulseMain * ML_PER_PULSE_MAIN;
    interrupts();
    JsonDocument doc;
    doc["ts"]        = (uint32_t)millis();
    doc["running"]   = systemRunning;
    doc["phase"]     = currentPhase;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["error"]     = systemError;

    auto mkValve = [&](const char* key, float vol, float target,
                       float flow, int32_t steps, bool isOpen, uint32_t rawPulses) {
        JsonObject v = doc["valves"][key].to<JsonObject>();
        v["open"]      = isOpen;
        v["steps"]     = steps;
        v["flow_lpm"]  = roundf(flow * 100.0f) / 100.0f;
        v["volume_ml"] = roundf(vol);
        v["pulses"]    = rawPulses;
        v["target_ml"] = roundf(target);
        v["percent"]   = (target > 0) ? min(100.0f, vol / target * 100.0f) : 0.0f;
    };
    mkValve("N", volN, targetN, flowLpmN, posN, targetN > 0 && !doneN, pulseN);
    mkValve("P", volP, targetP, flowLpmP, posP, targetP > 0 && !doneP, pulseP);
    mkValve("K", volK, targetK, flowLpmK, posK, targetK > 0 && !doneK, pulseK);
    doc["main_flow_lpm"] = roundf(flowLpmMain * 100.0f) / 100.0f;
    doc["main_volume_ml"] = roundf(volMain);
    doc["main_pulses"] = pulseMain;
    doc["total_target_ml"] = targetN + targetP + targetK;
    doc["total_volume_ml"] = volN + volP + volK;
    char buffer[700];
    size_t len = serializeJson(doc, buffer);
    mqttClient.publish(TOPIC_STATUS, (uint8_t*)buffer, len, false);
}

//====================================================================================================================================================================================================================
// SETUP
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println(F("\n╔══════════════════════════════════════╗"));
    Serial.println(F("  ║  HỆ THỐNG PHỐI TRỘN PHÂN TỰ ĐỘNG     ║"));
    Serial.println(F("  ╚══════════════════════════════════════╝"));

    // LED trạng thái
    pinMode(STATUS_LED, OUTPUT);
    digitalWrite(STATUS_LED, LOW);

    // Khởi tạo chân stepper
    int stepperPins[] = {STEP_N, DIR_N, EN_N, STEP_P, DIR_P, EN_P, STEP_K, DIR_K, EN_K};
    for (int pin : stepperPins) pinMode(pin, OUTPUT);

    // Giả định van đã đóng sẵn từ trước để chống kẹt xung khi bật nguồn
    Serial.println(F("[INIT] Khởi tạo vị trí van kim về vị trí 0 (đã đóng)..."));
    posN = 0; posP = 0; posK = 0;
    digitalWrite(EN_N, HIGH); // Tắt driver (ngắt điện) để tiết kiệm điện và giảm nóng động cơ (TB6600 Active-LOW)
    digitalWrite(EN_P, HIGH);
    digitalWrite(EN_K, HIGH);

    // Khởi tạo chân bơm và van chính
    pinMode(PUMP_PIN, OUTPUT);
    pinMode(VALVE_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW); // Mặc định tắt (giả sử active HIGH)
    digitalWrite(VALVE_PIN, LOW);

    // Khởi tạo cảm biến lưu lượng (Dùng PULLUP nội bộ để chống nhiễu)
    pinMode(FLOW_N, INPUT_PULLUP);
    pinMode(FLOW_P, INPUT_PULLUP);
    pinMode(FLOW_K, INPUT_PULLUP);
    pinMode(FLOW_MAIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(FLOW_N), onFlowN, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_P), onFlowP, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_K), onFlowK, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_MAIN), onFlowMain, RISING);
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

//====================================================================================================================================================================================================================
// LOOP
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
    // Xử lý logic bơm (chỉ chạy chế độ ĐỒNG THỜI)
    if (systemRunning) {
        if (now - lastControlTime >= CONTROL_INTERVAL_MS) {
            controlSimultaneous();
            lastControlTime = now;
        }
    }
    // Publish trạng thái về server
    if (now - lastPublish >= PUBLISH_INTERVAL) {
        publishStatus();
        lastPublish = now;
    }
}
