#include <WiFi.h>
#include <time.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// CẤU HÌNH WIFI & MQTT
const char* WIFI_SSID     = "huuducc";
const char* WIFI_PASSWORD = "190520044";
const char* MQTT_SERVER   = "broker.hivemq.com"; //Cloud MQTT
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";
const char* MQTT_PASS     = "";

const int32_t stagePosN[4] = {2700, 3300, 3300, 2700}; // cây con, sinh trưởng, ra hoa, nuôi quả
const int32_t stagePosP[4] = {530, 530, 480, 480};
const int32_t stagePosK[4] = {670, 840, 1400, 3000};

bool isProbing = false;
int probeStageIndex = -1;
String probeStageName = "";
unsigned long probeStableTime = 0;

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
#define MAX_OPEN_STEPS_N  12800
#define MAX_OPEN_STEPS_P  8200
#define MAX_OPEN_STEPS_K  9200
// speed step
#define STEP_DELAY_US   200 
 
// Hiệu chỉnh YF-S401 (Hệ số cơ sở ở lưu lượng cao > 0.5 LPM)
#define ML_PER_PULSE_N      0.21314f
#define ML_PER_PULSE_P      0.20298f
#define ML_PER_PULSE_K      0.20195f
#define ML_PER_PULSE_MAIN   44.35324f

#define DEADBAND_LPM        0.0f    // Loại bỏ vùng chết cảm biến (bằng 0.0f)

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

// Bảng tra cứu 6 điểm (2 điểm giới hạn max-min và 4 điểm giai đoạn nông nghiệp)
const int NUM_POINTS_N = 6;
const int NUM_POINTS_P = 6;
const int NUM_POINTS_K = 6;
CalibrationPoint lutN[NUM_POINTS_N];
CalibrationPoint lutP[NUM_POINTS_P];
CalibrationPoint lutK[NUM_POINTS_K];

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

// Hàm tính toán hệ số mL trên mỗi xung động dựa trên lưu lượng mục tiêu để bù sai số trượt tuabin ở dải thấp
float getDynamicMlPerPulse(float targetFlow, float baseFactor) {
    return baseFactor;
}

// Hàm cập nhật bảng tra cứu 6 điểm động từ bộ nhớ Preferences
void updateLUTs() {
    float totalLpm = 0.8f; // 0.80000f
    
    // Ratios: Seedling/Vegetative (1:1:1), Flowering (2:1:3), Fruiting (5:3:10)
    float fN0 = totalLpm * 1.0f / 3.0f; // 0.26667f
    float fP0 = totalLpm * 1.0f / 3.0f;
    float fK0 = totalLpm * 1.0f / 3.0f;
    
    float fN1 = totalLpm * 1.0f / 3.0f; // 0.26667f
    float fP1 = totalLpm * 1.0f / 3.0f;
    float fK1 = totalLpm * 1.0f / 3.0f;
    
    float fN2 = totalLpm * 2.0f / 6.0f; // 0.26667f
    float fP2 = totalLpm * 1.0f / 6.0f; // 0.13333f
    float fK2 = totalLpm * 3.0f / 6.0f; // 0.40000f
    
    float fN3 = totalLpm * 5.0f / 18.0f; // 0.22222f
    float fP3 = totalLpm * 3.0f / 18.0f; // 0.13333f
    float fK3 = totalLpm * 10.0f / 18.0f; // 0.44444f

    auto populateAndSort = [](CalibrationPoint* lut, const int32_t* stagePos, float qMax, int32_t maxSteps, float f0, float f1, float f2, float f3) {
        lut[0] = {0.0f, 0};
        lut[1] = {f0, stagePos[0]};
        lut[2] = {f1, stagePos[1]};
        lut[3] = {f2, stagePos[2]};
        lut[4] = {f3, stagePos[3]};
        lut[5] = {qMax, maxSteps};

        // Sắp xếp nổi bọt (Bubble Sort) theo flowLpm tăng dần
        for (int i = 0; i < 5; i++) {
            for (int j = 0; j < 5 - i; j++) {
                if (lut[j].flowLpm > lut[j+1].flowLpm) {
                    CalibrationPoint temp = lut[j];
                    lut[j] = lut[j+1];
                    lut[j+1] = temp;
                }
            }
        }
        // Xử lý trùng lặp lưu lượng để tránh chia cho 0 khi nội suy
        for (int i = 0; i < 5; i++) {
            if (lut[i+1].flowLpm <= lut[i].flowLpm + 0.001f) {
                lut[i+1].flowLpm = lut[i].flowLpm + 0.001f;
            }
        }
    };
    populateAndSort(lutN, stagePosN, Q_MAX_LPM_N, MAX_OPEN_STEPS_N, fN0, fN1, fN2, fN3);
    populateAndSort(lutP, stagePosP, Q_MAX_LPM_P, MAX_OPEN_STEPS_P, fP0, fP1, fP2, fP3);
    populateAndSort(lutK, stagePosK, Q_MAX_LPM_K, MAX_OPEN_STEPS_K, fK0, fK1, fK2, fK3);
}
//====================================================================================================================================================================================================================
// BIẾN TOÀN CỤC
// --- Bộ đếm xung cảm biến (Sử dụng Ngắt Mềm) ---
volatile uint32_t pulseN = 0;
volatile uint32_t pulseP = 0;
volatile uint32_t pulseK = 0;
volatile uint32_t pulseMain = 0;

void IRAM_ATTR onFlowN() { pulseN++; }
void IRAM_ATTR onFlowP() { pulseP++; }
void IRAM_ATTR onFlowK() { pulseK++; }
void IRAM_ATTR onFlowMain() { pulseMain++; }
// Snapshot để tính flow rate
uint32_t snapPulseN = 0, snapPulseP = 0, snapPulseK = 0, snapPulseMain = 0;
float    flowLpmN = 0.0f, flowLpmP = 0.0f, flowLpmK = 0.0f, flowLpmMain = 0.0f;

void resetPulses() {
    pulseN = pulseP = pulseK = pulseMain = 0;
    snapPulseN = snapPulseP = snapPulseK = snapPulseMain = 0;
}
// Cấu trúc cửa sổ trượt (sliding window) để tính lưu lượng phản hồi nhanh
#define FLOW_WINDOW_SIZE    5
uint32_t historyN[FLOW_WINDOW_SIZE] = {0};
uint32_t historyP[FLOW_WINDOW_SIZE] = {0};
uint32_t historyK[FLOW_WINDOW_SIZE] = {0};
uint32_t historyMain[FLOW_WINDOW_SIZE] = {0};
uint8_t flowWindowIdx = 0;
// Mục tiêu thể tích (mL)
float targetN = 0.0f, targetP = 0.0f, targetK = 0.0f;
// Vị trí hiện tại của van (số micro-bước từ vị trí đóng)
int32_t posN = 0, posP = 0, posK = 0;
float compN = 0.0f, compP = 0.0f, compK = 0.0f; // Biến bù trừ tích phân (I) cho bộ điều khiển PI
// Các biến bảo vệ & self-learning
int32_t learnedMinN = 0, learnedMaxN = MAX_OPEN_STEPS_N;
int32_t learnedMinP = 0, learnedMaxP = MAX_OPEN_STEPS_P;
int32_t learnedMinK = 0, learnedMaxK = MAX_OPEN_STEPS_K;

int32_t lastSatPosN = 0, lastSatPosP = 0, lastSatPosK = 0;
float lastSatFlowN = 0.0f, lastSatFlowP = 0.0f, lastSatFlowK = 0.0f;

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
unsigned long zeroFlowDuration = 0; // Thời gian không có lưu lượng nước (ms)
unsigned long lastFlowTime = 0;     // Thời điểm cuối cùng có lưu lượng

// MQTT Topics (Đã đổi để tránh bị trùng với người khác trên public broker)
const char* TOPIC_CMD    = "autofert_khoaluan2026/cmd";
const char* TOPIC_STATUS = "autofert_khoaluan2026/status";
// Clients
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

String getRealTime() {
    struct tm timeinfo;
    if(!getLocalTime(&timeinfo, 10)){
        return String(millis());
    }
    char timeStringBuff[20];
    strftime(timeStringBuff, sizeof(timeStringBuff), "%H:%M:%S", &timeinfo);
    return String(timeStringBuff);
}
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
                    Serial.printf("[%s] [VAN %d] Kich gioi han MAX (%d buoc)!\n", getRealTime().c_str(), valve, stepMax);
                    break;
                }
                (*posPtr)++;
            } else {
                if (*posPtr <= stepMin) {
                    Serial.printf("[%s] [VAN %d] Kich gioi han MIN (%d buoc)!\n", getRealTime().c_str(), valve, stepMin);
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
    digitalWrite(enPin, HIGH); // Tắt driver (ngắt điện) khi dừng quay để tiết kiệm điện và giảm nóng
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
    // Tắt driver (ngắt điện) các động cơ khi đứng yên để tiết kiệm điện, tránh nhiễu và giảm nóng
    digitalWrite(EN_N, HIGH);
    digitalWrite(EN_P, HIGH);
    digitalWrite(EN_K, HIGH);
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
    Serial.printf("[%s] [VAN %c] Mo %d%% -> di chuyen %d buoc (Viri hientai: %d, Target: %d)\n", getRealTime().c_str(),
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
    Serial.printf("[%s] \n!!! DỪNG KHẨN CẤP - Ngắt toàn bộ thiết bị ngay lập tức !!!\n\n", getRealTime().c_str());
    systemRunning = false;
    currentPhase  = 0;
    simMode       = false;
    doneN = doneP = doneK = false;
    monitoringN = monitoringP = monitoringK = false;
    extraCloseN = extraCloseP = extraCloseK = 0;
    
    // Tắt Bơm và Van điện từ chính ngay lập tức để ngắt dòng chảy
    digitalWrite(PUMP_PIN, LOW);
    digitalWrite(VALVE_PIN, LOW);
    
    // Đóng các van kim đồng thời về vị trí 0 chống rò rỉ dung dịch phân bón
    moveSteppersSimultaneous(-posN, -posP, -posK);
    posN = 0; posP = 0; posK = 0;
    digitalWrite(EN_N, HIGH);
    digitalWrite(EN_P, HIGH);
    digitalWrite(EN_K, HIGH);
}
//====================================================================================================================================================================================================================
// MQTT CALLBACK - Nhận lệnh từ server
// ĐIỀU KHIỂN TỈ LỆ - CHẠY ĐỒNG THỜI (P-Controller)
// Gọi trong loop() mỗi CONTROL_INTERVAL_MS ms
void controlSimultaneous() {
    unsigned long now = millis();
    if (now - lastControlTime < CONTROL_INTERVAL_MS) return;
    lastControlTime = now;
    static unsigned long lastTightenN = 0;
    static unsigned long lastTightenP = 0;
    static unsigned long lastTightenK = 0;

    // 1. KIỂM TRA ĐIỀU KIỆN KẾT THÚC CHU TRÌNH TOÀN BỘ (Có xả ống 10% cuối chu trình sau châm phân)
    if (systemRunning) {
        float currentVolL = (pulseMain * ML_PER_PULSE_MAIN) / 1000.0f;
        
        // Giám sát lỗi nguồn nước (Thấp dòng hoặc mất dòng - 30s timeout)
        if (flowLpmMain >= 15.0f) {
            lastFlowTime = now;
            zeroFlowDuration = 0;
        } else {
            zeroFlowDuration = now - lastFlowTime;
            if (zeroFlowDuration >= 30000 && currentPhase == 100) {
                Serial.printf("[%s] [CẢNH BÁO] Lưu lượng nước không đủ (< 15 L/phút) hoặc mất nước trong 30s. Dừng hệ thống bảo vệ bơm!\n", getRealTime().c_str());
                systemError = "LOW_FLOW_TIMEOUT";
                emergencyStop();
                digitalWrite(PUMP_PIN, LOW);
                digitalWrite(VALVE_PIN, LOW);
                systemRunning = false;
                currentPhase = 4;
                publishStatus();
                return;
            }
        }
        
        // Dừng ngay khi lưu lượng chính (đo thực tế từ cảm biến) đạt đúng mục tiêu
        // Không dùng thời gian lý thuyết để tránh vọt lố khi bơm chạy nhanh hơn dự kiến
        bool waterDone = (targetTotalWaterL > 0.0f && currentVolL >= targetTotalWaterL);   
        if (waterDone) {
            // Kiểm tra lượng phân có châm đủ không
            float volN = (pulseN * ML_PER_PULSE_N);
            float volP = (pulseP * ML_PER_PULSE_P);
            float volK = (pulseK * ML_PER_PULSE_K);
            bool dosingOk = (targetN <= 0.0f || volN >= targetN * 0.9f)
                         && (targetP <= 0.0f || volP >= targetP * 0.9f)
                         && (targetK <= 0.0f || volK >= targetK * 0.9f);

            if (!dosingOk) {
                // Nước đủ nhưng phân chưa đủ 90% → cảnh báo lỗi
                systemError = "DOSING_INCOMPLETE";
                Serial.printf("[%s] [CẢNH BÁO] Đủ nước (%.1f L) nhưng phân CHƯA ĐỦ! N=%.0f/%.0fmL P=%.0f/%.0fmL K=%.0f/%.0fmL\n",
                              getRealTime().c_str(), currentVolL,
                              volN, targetN, volP, targetP, volK, targetK);
            } else {
                Serial.printf("[%s] [KẾT THÚC] Hoàn thành chu kỳ tưới. Nước: %.1f L | N=%.0f/%.0fmL P=%.0f/%.0fmL K=%.0f/%.0fmL\n",
                              getRealTime().c_str(), currentVolL,
                              volN, targetN, volP, targetP, volK, targetK);
            }
            emergencyStop();
            digitalWrite(PUMP_PIN, LOW);
            digitalWrite(VALVE_PIN, LOW);
            systemRunning = false;
            currentPhase = 4; // Phase 4 = Completed
            publishStatus(); // Gửi báo cáo MQTT (kèm systemError nếu có)
            return;
        }
    }
    // Chỉ thực thi đọc lưu lượng khi simMode = true (Tức là chưa châm xong phân)
    if (!simMode) return;
    float factorN = getDynamicMlPerPulse(targetLpmN, ML_PER_PULSE_N);
    float factorP = getDynamicMlPerPulse(targetLpmP, ML_PER_PULSE_P);
    float factorK = getDynamicMlPerPulse(targetLpmK, ML_PER_PULSE_K);
    float volN = pulseN * factorN;
    float volP = pulseP * factorP;
    float volK = pulseK * factorK;

    // Kiểm tra và đóng van N
    if (!doneN && targetN > 0.0f && volN >= targetN) {
        Serial.printf("[%s] [SIM] Bồn N đạt mục tiêu: %.1f/%.1f mL. Đóng van N.\n", getRealTime().c_str(), volN, targetN);
        closeValve(1);
        doneN = true;
    }
    // Kiểm tra và đóng van P
    if (!doneP && targetP > 0.0f && volP >= targetP) {
        Serial.printf("[%s] [SIM] Bồn P đạt mục tiêu: %.1f/%.1f mL. Đóng van P.\n", getRealTime().c_str(), volP, targetP);
        closeValve(2);
        doneP = true;
    }
    // Kiểm tra và đóng van K
    if (!doneK && targetK > 0.0f && volK >= targetK) {
        Serial.printf("[%s] [SIM] Bồn K đạt mục tiêu: %.1f/%.1f mL. Đóng van K.\n", getRealTime().c_str(), volK, targetK);
        closeValve(3);
        doneK = true;
    }

    // Nếu tất cả các bồn có setpoint > 0 đều đã đạt mục tiêu
    bool allDosingDone = (targetN <= 0.0f || doneN) &&
                         (targetP <= 0.0f || doneP) &&
                         (targetK <= 0.0f || doneK);
    if (allDosingDone) {
        Serial.printf("[%s] [SIM] Tất cả bồn phân đã châm đủ. Tắt chế độ châm phân, tiếp tục tưới nước chính đến %.1f L.\n", getRealTime().c_str(), targetTotalWaterL);
        simMode = false;
    }
}
//====================================================================================================================================================================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    char buf[513];
    length = min(length, (unsigned int)512);
    memcpy(buf, payload, length);
    buf[length] = '\0';
    Serial.printf("[%s] \n[MQTT←] Topic: %s\n[MQTT←] Data: %s\n", getRealTime().c_str(), topic, buf);
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, buf);
    if (err) {
        Serial.printf("[%s] [!] Lỗi JSON: %s\n", getRealTime().c_str(), err.c_str());
        return;
    }
    const char* cmd = doc["cmd"];
    if (!cmd) return;

    if (strcmp(cmd, "probe_stage") == 0) {
        if (systemRunning) { Serial.printf("[%s] [!] Hệ thống đang chạy. Bỏ qua lệnh probe.\n", getRealTime().c_str()); return; }
        const char* stage = doc["agri_stage"] | "flowering";
        int cycles = doc["agri_cycles"].as<int>();
        if (cycles <= 0) cycles = 30;        
        probeStageName = String(stage);
        if (probeStageName == "seedling") probeStageIndex = 0;
        else if (probeStageName == "vegetative") probeStageIndex = 1;
        else if (probeStageName == "flowering") probeStageIndex = 2;
        else if (probeStageName == "fruiting") probeStageIndex = 3;
        else probeStageIndex = -1;

        if (probeStageIndex >= 0) {
            isProbing = true;
            probeStableTime = 0;
            // Tính toán lưu lượng mục tiêu giống như start_agri
            float waterDay = 2400.0f * 2.0f; // 4800 L
            float dayVolN = 0, dayVolP = 0, dayVolK = 0;
            
            if (probeStageIndex == 0) { dayVolN = 20.0f; dayVolP = 20.0f; dayVolK = 20.0f; }
            else if (probeStageIndex == 1) { dayVolN = 25.0f; dayVolP = 20.0f; dayVolK = 25.0f; }
            else if (probeStageIndex == 2) { dayVolN = 25.0f; dayVolP = 18.0f; dayVolK = 30.0f; }
            else if (probeStageIndex == 3) { dayVolN = 20.0f; dayVolP = 18.0f; dayVolK = 35.0f; }

            targetN = (dayVolN * 1000.0f) / cycles;
            targetP = (dayVolP * 1000.0f) / cycles;
            targetK = (dayVolK * 1000.0f) / cycles;
            targetTotalWaterL = 999999.0f; // Không dừng theo lượng nước vì chỉ dò
            
            float timeMin = (waterDay / cycles) / 80.0f; // Lưu lượng bơm 80L/phút
            targetLpmN = (targetN / 1000.0f) / timeMin;
            targetLpmP = (targetP / 1000.0f) / timeMin;
            targetLpmK = (targetK / 1000.0f) / timeMin;
            
            Serial.printf("[%s] [PROBE] Bắt đầu dò điểm cho %s...\n", getRealTime().c_str(), stage);
            goto start_init_label;
        }
        return;
    }
    if (strcmp(cmd, "start_agri") == 0) {
        if (systemRunning) { Serial.printf("[%s] [!] Hệ thống đang chạy. Bỏ qua lệnh start_agri.\n", getRealTime().c_str()); return; }
        isProbing = false;
        const char* stage = doc["agri_stage"] | "flowering";
        
        probeStageName = String(stage);
        if (probeStageName == "seedling") probeStageIndex = 0;
        else if (probeStageName == "vegetative") probeStageIndex = 1;
        else if (probeStageName == "flowering") probeStageIndex = 2;
        else if (probeStageName == "fruiting") probeStageIndex = 3;
        else probeStageIndex = -1;

        int cycles = doc["agri_cycles"].as<int>();
        if (cycles <= 0) cycles = 1;
        
        float waterDay = 2400.0f * 2.0f; // 4800 L
        float dayVolN = 0, dayVolP = 0, dayVolK = 0;
        
        if (strcmp(stage, "seedling") == 0) { dayVolN = 20.0f; dayVolP = 20.0f; dayVolK = 20.0f; }
        else if (strcmp(stage, "vegetative") == 0) { dayVolN = 25.0f; dayVolP = 20.0f; dayVolK = 25.0f; }
        else if (strcmp(stage, "flowering") == 0) { dayVolN = 25.0f; dayVolP = 18.0f; dayVolK = 30.0f; }
        else if (strcmp(stage, "fruiting") == 0) { dayVolN = 20.0f; dayVolP = 18.0f; dayVolK = 35.0f; }
        
        targetN = (dayVolN * 1000.0f) / cycles;
        targetP = (dayVolP * 1000.0f) / cycles;
        targetK = (dayVolK * 1000.0f) / cycles;
        targetTotalWaterL = waterDay / cycles;
        
        float timeMin = targetTotalWaterL / 80.0f; // Lưu lượng bơm 80L/phút
        targetLpmN = (targetN / 1000.0f) / timeMin;
        targetLpmP = (targetP / 1000.0f) / timeMin;
        targetLpmK = (targetK / 1000.0f) / timeMin;

        goto start_init_label;
    }   
    // ---- Lệnh KHỞI ĐỘNG PHA TRỘN ĐỒNG THỜI ----
    if (strcmp(cmd, "start_sim") == 0) {
        if (systemRunning) { Serial.printf("[%s] [!] Hệ thống đang chạy. Bỏ qua lệnh start.\n", getRealTime().c_str()); return; }
        isProbing = false;
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
        targetTotalWaterL = doc["total_water_l"] | 0.0f;
start_init_label:
        // Thiết lập vị trí phần mềm về 0 vì van đã đóng hoàn toàn (vị trí 0) trước khi hoạt động
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
        resetPulses();
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
               
        // Đã loại bỏ các biến PID cũ
        Serial.printf("[%s] [SIM] N=%.0fmL@%.2fL/m | P=%.0fmL@%.2fL/m | K=%.0fmL@%.2fL/m\n", getRealTime().c_str(),
                       targetN, targetLpmN,
                       targetP, targetLpmP,
                       targetK, targetLpmK);
        simMode = true;
        systemRunning = true;
        currentPhase  = 100;  // 100 = chế độ đồng thời
        systemError = "";      
        compN = 0.0f;
        compP = 0.0f;
        compK = 0.0f;

        // Khởi động hệ thống theo thuật toán VanhanhHethong.ino
        if (targetN > 0 || targetP > 0 || targetK > 0 || targetTotalWaterL > 0.0f) {
            // Bước 1: Mở van điện từ chính
            Serial.printf("[%s] [SIM] Mở van chính và thiết lập vị trí van kim...\n", getRealTime().c_str());
            digitalWrite(VALVE_PIN, HIGH);

            // Tính số bước motor từ lưu lượng mục tiêu qua bảng LUT (nội suy tuyến tính 6 điểm)
            // Thay thế công thức magic number (LPM * 1000 / 500 * MAX_STEPS) bằng getStepsFromFlow()
            int initN = 0;
            if (targetN > 0) {
                initN = (int)getStepsFromFlow(targetLpmN, lutN, NUM_POINTS_N);
                initN = constrain(initN, 0, (int)MAX_OPEN_STEPS_N);
            }
            int initP = 0;
            if (targetP > 0) {
                initP = (int)getStepsFromFlow(targetLpmP, lutP, NUM_POINTS_P);
                initP = constrain(initP, 0, (int)MAX_OPEN_STEPS_P);
            }
            int initK = 0;
            if (targetK > 0) {
                initK = (int)getStepsFromFlow(targetLpmK, lutK, NUM_POINTS_K);
                initK = constrain(initK, 0, (int)MAX_OPEN_STEPS_K);
            }

            // Quay các motor đến vị trí xung cố định đã tính toán
            if (initN > 0 || initP > 0 || initK > 0) {
                moveSteppersSimultaneous(initN, initP, initK);
            }

            // Chờ 7 giây cho van mở ổn định và nước điền đầy (giống VanhanhHethong.ino)
            Serial.printf("[%s] [SIM] Đang chờ 7 giây cho van mở ổn định...\n", getRealTime().c_str());
            unsigned long startOpen = millis();
            while (millis() - startOpen < 7000) {
                mqttClient.loop();
                delay(10);
            }

            // Bước 2: Bật bơm chính
            Serial.printf("[%s] [SIM] Khởi động bơm chính...\n", getRealTime().c_str());
            digitalWrite(PUMP_PIN, HIGH);

            // Reset bộ đếm xung NGAY SAU khi bơm bật để tránh đếm lượng nước
            // chảy tự do trong 7 giây ổn định van vào tổng thể tích tưới chính
            resetPulses();
        }       
        lastControlTime = millis();
        runStartTime = millis();        
        lastFlowTime = millis();
        zeroFlowDuration = 0;
        Serial.printf("[%s] [SIM] Tất cả van đã mở - vòng lặp điều khiển bắt đầu!\n", getRealTime().c_str());
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
                    // Nếu van đã ghi nhận vị trí mở, đóng van chính xác về 0 (di chuyển -pos bước)
                    closeValve(valve);
                }
                pos = 0;
                digitalWrite(enPin, HIGH); // Tắt driver (ngắt điện) để bảo vệ động cơ
            };
            smartHome(1, posN, EN_N);
            smartHome(2, posP, EN_P);
            smartHome(3, posK, EN_K);
            Serial.printf("[%s] [HOME] Đã đặt lại vị trí gốc và ngắt điện động cơ (Không siết thêm).\n", getRealTime().c_str());
        }
    }
    // ---- Lệnh RESET THỂ TÍCH TỔNG ĐƯỜNG ỐNG CHÍNH ----
    else if (strcmp(cmd, "reset_main") == 0) {
        pulseMain = 0;
        snapPulseMain = 0;
        flowLpmMain = 0.0f;
        Serial.printf("[%s] [RESET] Đã reset thể tích đường ống chính về 0.\n", getRealTime().c_str());
        publishStatus();
    }
    // ---- Lệnh ĐIỀU KHIỂN THỦ CÔNG (Bơm, Van điện từ) ----
    else if (strcmp(cmd, "manual") == 0) {
        const char* device = doc["device"];
        bool state = doc["state"];
        if (device) {
            if (strcmp(device, "pump") == 0) {
                digitalWrite(PUMP_PIN, state ? HIGH : LOW);
                Serial.printf("[%s] [MANUAL] Bơm nước: %s\n", getRealTime().c_str(), state ? "BẬT" : "TẮT");
            } else if (strcmp(device, "main_valve") == 0) {
                digitalWrite(VALVE_PIN, state ? HIGH : LOW);
                Serial.printf("[%s] [MANUAL] Van chính: %s\n", getRealTime().c_str(), state ? "BẬT" : "TẮT");
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
            Serial.printf("[%s] [MANUAL] Test stepper %s: %d bước (Vị trí mới: N=%d, P=%d, K=%d)\n", getRealTime().c_str(), 
                          type, steps, posN, posP, posK);
        }
    }
}
//====================================================================================================================================================================================================================
// TÍNH LƯU LƯỢNG (L/phút)
void calculateFlowRates() {
    unsigned long now = millis();
    float dt_s = (now - lastFlowCalc) / 1000.0f;
    if (dt_s < 0.01f) return;
// Lấy snapshot xung
    uint32_t pN = pulseN;
    uint32_t pP = pulseP;
    uint32_t pK = pulseK;
    uint32_t pMain = pulseMain;
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
    float factorN = getDynamicMlPerPulse(targetLpmN, ML_PER_PULSE_N);
    float factorP = getDynamicMlPerPulse(targetLpmP, ML_PER_PULSE_P);
    float factorK = getDynamicMlPerPulse(targetLpmK, ML_PER_PULSE_K);

    flowLpmN = sumN * factorN * 0.06f; 
    flowLpmP = sumP * factorP * 0.06f; 
    flowLpmK = sumK * factorK * 0.06f; 
    flowLpmMain = sumMain * ML_PER_PULSE_MAIN * 0.06f; // Cảm biến DN32 ống chính (Q = sum * ML_PER_PULSE * 0.06)
    lastFlowCalc = now;

    // --- IN LOG CHU KỲ RA SERIAL MONITOR (mỗi 1 giây) ---
    if (systemRunning && (now - lastSerialLog >= 1000)) {
        lastSerialLog = now;
        serialLogCount++;
        unsigned long elapsed = (now - runStartTime) / 1000;
        
        // Tính phần trăm hoàn thành
        float pctN = (targetN > 0) ? min(100.0f, (pulseN * factorN) / targetN * 100.0f) : 0.0f;
        float pctP = (targetP > 0) ? min(100.0f, (pulseP * factorP) / targetP * 100.0f) : 0.0f;
        float pctK = (targetK > 0) ? min(100.0f, (pulseK * factorK) / targetK * 100.0f) : 0.0f;        
        // In header mỗi 10 dòng
        if (serialLogCount == 1 || serialLogCount % 10 == 1) {
            Serial.printf("[%s] \n[BÁO CÁO] =======================================================================\n", getRealTime().c_str());
            Serial.printf("[%s] [BÁO CÁO] T(s) | Bồn  | TốcĐộ(L/m) | ĐãHút(mL) | MụcTiêu(mL)| BướcVan| T.Thái\n", getRealTime().c_str());
            Serial.printf("[%s] [BÁO CÁO] -----+------+------------+-----------+------------+--------+-------\n", getRealTime().c_str());
        }       
        // In dữ liệu từng bồn
        Serial.printf("[%s] [BÁO CÁO] %4lus | N    | %10.3f | %9.1f | %10.0f | %6d | %s\n", getRealTime().c_str(),
            elapsed, flowLpmN, pulseN * factorN, targetN, posN, doneN ? "XONG" : "BƠM ");
        Serial.printf("[%s] [BÁO CÁO] %4lus | P    | %10.3f | %9.1f | %10.0f | %6d | %s\n", getRealTime().c_str(),
            elapsed, flowLpmP, pulseP * factorP, targetP, posP, doneP ? "XONG" : "BƠM ");
        Serial.printf("[%s] [BÁO CÁO] %4lus | K    | %10.3f | %9.1f | %10.0f | %6d | %s\n", getRealTime().c_str(),
            elapsed, flowLpmK, pulseK * factorK, targetK, posK, doneK ? "XONG" : "BƠM ");
        Serial.printf("[%s] [BÁO CÁO] %4lus | NƯỚC | %10.3f | %9.1f | %10.1f | ------ | ---\n", getRealTime().c_str(),
            elapsed, flowLpmMain, pulseMain * ML_PER_PULSE_MAIN, targetTotalWaterL * 1000.0f);
        Serial.printf("[%s] [BÁO CÁO] -----+------+------------+-----------+------------+--------+-------\n", getRealTime().c_str());
    }
    // Reset đếm khi hệ thống dừng
    if (!systemRunning) { serialLogCount = 0; lastSerialLog = 0; }
}
// KẾT NỐI MQTT
void mqttReconnect() {
    if (millis() - lastReconnectTry < 5000) return;
    lastReconnectTry = millis();

    String clientId = "ESP32Fert_" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.printf("[%s] [MQTT] Kết nối tới %s:%d (id=%s)...\n", getRealTime().c_str(),
                  MQTT_SERVER, MQTT_PORT, clientId.c_str());
    bool ok;
    if (strlen(MQTT_USER) > 0) {
        ok = mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS);
    } else {
        ok = mqttClient.connect(clientId.c_str());
    }
    if (ok) {
        Serial.printf("[%s] [MQTT] ✓ Đã kết nối!\n", getRealTime().c_str());
        mqttClient.subscribe(TOPIC_CMD, 1);  // QoS 1
        digitalWrite(STATUS_LED, HIGH);
    } else {
        Serial.printf("[%s] [MQTT] ✗ Thất bại (rc=%d). Thử lại sau 5s...\n", getRealTime().c_str(),
                      mqttClient.state());
        digitalWrite(STATUS_LED, LOW);
    }
}
//====================================================================================================================================================================================================================
// PUBLISH TRẠNG THÁI LÊN MQTT
void publishStatus() {
    float volN = pulseN * getDynamicMlPerPulse(targetLpmN, ML_PER_PULSE_N);
    float volP = pulseP * getDynamicMlPerPulse(targetLpmP, ML_PER_PULSE_P);
    float volK = pulseK * getDynamicMlPerPulse(targetLpmK, ML_PER_PULSE_K);
    float volMain = pulseMain * ML_PER_PULSE_MAIN;
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
    doc["target_water_l"] = targetTotalWaterL;
    doc["total_target_ml"] = targetN + targetP + targetK;
    doc["total_volume_ml"] = volN + volP + volK;
    char buffer[1024];
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
    updateLUTs(); // Cập nhật bảng tra cứu 6 điểm động
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

    // Khởi tạo ngắt mềm (Software Interrupt) cho cảm biến lưu lượng
    // Sử dụng FALLING để tương thích với cảm biến Hall
    pinMode(FLOW_N, INPUT_PULLUP);
    pinMode(FLOW_P, INPUT_PULLUP);
    pinMode(FLOW_K, INPUT_PULLUP);
    pinMode(FLOW_MAIN, INPUT_PULLUP);

    attachInterrupt(digitalPinToInterrupt(FLOW_N), onFlowN, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_P), onFlowP, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_K), onFlowK, RISING);
    attachInterrupt(digitalPinToInterrupt(FLOW_MAIN), onFlowMain, RISING);
    Serial.println(F("[OK] Cảm biến lưu lượng sử dụng Ngắt Mềm (attachInterrupt) - Đã khôi phục logic chống đếm sót xung khi Stepper chạy"));

    // Kết nối WiFi
    Serial.printf("[%s] [WiFi] Kết nối tới '%s'", getRealTime().c_str(), WIFI_SSID);
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
        Serial.printf("[%s] \n[WiFi] ✓ Đã kết nối! IP: %s\n", getRealTime().c_str(), WiFi.localIP().toString().c_str());
        digitalWrite(STATUS_LED, HIGH);
    } else {
        Serial.println(F("\n[WiFi] ✗ Không kết nối được! Kiểm tra SSID/Password"));
    }
    
    // Cấu hình MQTT
    mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(1024);
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
