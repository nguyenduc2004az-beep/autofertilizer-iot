#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
//====================================================================================================================================================================================================================
// CẤU HÌNH WIFI & MQTT
const char* WIFI_SSID     = "huuduc";       // Điền tên WiFi ở Nhà lưới vào đây
const char* WIFI_PASSWORD = "19052004";     // Điền mật khẩu WiFi ở Nhà lưới vào đây
const char* MQTT_SERVER   = "broker.hivemq.com"; // Sử dụng Cloud MQTT
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";    // Để trống nếu không dùng xác thực
const char* MQTT_PASS     = "";
//====================================================================================================================================================================================================================
// khai báo chân kết nối cho driver TB6600
#define DIR_N      13
#define STEP_N     14
#define EN_N       32

#define DIR_P      27
#define STEP_P     26
#define EN_P       22

#define DIR_K      25
#define STEP_K     33
#define EN_K       23

// khai báo chân kết nối cho cảm biến lưu lượng
#define FLOW_N     16
#define FLOW_P     17
#define FLOW_K     18
#define FLOW_MAIN  19

// khai báo chân kết nối cho van điện từ và bơm
#define PUMP_PIN   4
#define VALVE_PIN  5

// khai báo led trạng thái 
#define STATUS_LED  2
#define STEPS_PER_REV   200
#define MICROSTEP       8

// Giới hạn số bước vi bước 1/8 từ đóng hoàn toàn (min) đến mở hoàn toàn (max) cho từng van
#define MAX_OPEN_STEPS_N  12000
#define MAX_OPEN_STEPS_P  9000
#define MAX_OPEN_STEPS_K  8500
// Giảm từ 800us xuống 500us để tăng tốc độ đóng/mở van kim, giúp van đóng nhanh hơn khi đạt mục tiêu
#define STEP_DELAY_US   500 
 
// YF-S401 Flow Sensor:
#define ML_PER_PULSE_N      0.2052f
#define ML_PER_PULSE_P      0.1985f
#define ML_PER_PULSE_K      0.1950f
#define ML_PER_PULSE_MAIN   45.7516f // Cảm biến DN32 ống chính (27 xung/L -> 37.037 mL/xung)
// Chu kỳ publish và tính flow rate (ms)
#define PUBLISH_INTERVAL    200
#define FLOW_CALC_INTERVAL  200

// THÔNG SỐ ĐIỀU KHIỂN PHẢN HỒI & ĐÓN ĐẦU (PID & Feedforward)
// Q_MAX_LPM_X: Lưu lượng tối đa thực tế (L/phút) khi van mở tối đa (từ dữ liệu hiệu chuẩn)
#define Q_MAX_LPM_N     1.15f
#define Q_MAX_LPM_P     1.02f
#define Q_MAX_LPM_K     1.00f

#define KP_CONTROL     35.0f   // Hệ số tỉ lệ (Proportional)
#define KI_CONTROL      8.0f   // Hệ số tích phân (Integral)
#define KD_CONTROL      5.0f   // Hệ số vi phân (Derivative)
// Vùng chết: bỏ qua sai số nhỏ hơn giá trị này (L/phút)
#define DEADBAND_LPM    0.05f
// Số bước tối đa điều chỉnh mỗi chu kỳ (tăng lên 150 để phản hồi nhạy bén)
#define MAX_ADJ_STEPS   150
// Chu kỳ vòng điều khiển (ms) - Giảm xuống 250ms để PID nhạy hơn, bắt mục tiêu chính xác hơn
#define CONTROL_INTERVAL_MS  250
// Biến lưu trạng thái PID cho từng van
float errSumN = 0.0f, errSumP = 0.0f, errSumK = 0.0f;
float lastErrN = 0.0f, lastErrP = 0.0f, lastErrK = 0.0f;
// Tích lũy hiệu chỉnh từ PID (được giới hạn an toàn)
float pidOffsetN = 0.0f, pidOffsetP = 0.0f, pidOffsetK = 0.0f;
// Số bước mở nhanh ban đầu khi khởi động riêng cho từng bồn
#define INITIAL_STARTUP_STEPS_N  1300
#define INITIAL_STARTUP_STEPS_P  900
#define INITIAL_STARTUP_STEPS_K  850
// Điểm bắt đầu giảm tốc khi đóng van (giảm từ 1200 xuống 400 để đóng nhanh hơn ở thể tích nhỏ)
#define SLOW_CLOSE_THRESHOLD_STEPS  400

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
// GIỚI HẠN GÓC XOAY BAN ĐẦU (STARTUP CLAMP)
#define STARTUP_LIMIT_STEPS 2000
// BIẾN MÁY HỌC TỰ CÂN CHỈNH GIỚI HẠN AN TOÀN (SELF-LEARNING BOUNDARIES)
int32_t learnedMinN = 0, learnedMaxN = MAX_OPEN_STEPS_N;
int32_t learnedMinP = 0, learnedMaxP = MAX_OPEN_STEPS_P;
int32_t learnedMinK = 0, learnedMaxK = MAX_OPEN_STEPS_K;
// Theo dõi vị trí và lưu lượng để học độ bão hòa (saturating open limit)
int32_t lastSatPosN = 0, lastSatPosP = 0, lastSatPosK = 0;
float lastSatFlowN = 0.0f, lastSatFlowP = 0.0f, lastSatFlowK = 0.0f;
// ---- Biến chế độ ĐỒNG THỜI ----
bool simMode = false;                          // true = chế độ đồng thời đang chạy
float targetLpmN = 0.0f;                       // Lưu lượng mục tiêu van N (L/phút)
float targetLpmP = 0.0f;                       // Lưu lượng mục tiêu van P (L/phút)
float targetLpmK = 0.0f;                       // Lưu lượng mục tiêu van K (L/phút)
bool  doneN = false, doneP = false, doneK = false;  // Van đã đạt đủ lượng?
// Biến giám sát rò rỉ van sau khi đạt mục tiêu (5 giây)
bool monitoringN = false, monitoringP = false, monitoringK = false;
unsigned long closeTimerN = 0, closeTimerP = 0, closeTimerK = 0;
int extraCloseN = 0, extraCloseP = 0, extraCloseK = 0;
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

// Biến bảo vệ chạy khô (Flow Timeout Protection)
unsigned long runStartTime = 0;             // Thời điểm bắt đầu chạy chu trình (ms)
unsigned long zeroFlowDuration = 0;         // Thời gian liên tục không có lưu lượng (ms)
String systemError = "";                    // Mã lỗi hệ thống hiện tại
#define FLOW_TIMEOUT_MS  30000              // 30 giây không có lưu lượng sẽ ngắt
#define FLOW_GRACE_PERIOD_MS 10000          // 10 giây đầu cho phép lưu lượng = 0 để mồi nước/phân

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
    int32_t learnedMin = 0, learnedMax = MAX_OPEN_STEPS_N;
    switch (valve) {
        case 1:
            stepPin = STEP_N; dirPin = DIR_N; enPin = EN_N;
            posPtr = &posN; learnedMin = learnedMinN; learnedMax = learnedMaxN;
            break;
        case 2:
            stepPin = STEP_P; dirPin = DIR_P; enPin = EN_P;
            posPtr = &posP; learnedMin = learnedMinP; learnedMax = learnedMaxP;
            break;
        case 3:
            stepPin = STEP_K; dirPin = DIR_K; enPin = EN_K;
            posPtr = &posK; learnedMin = learnedMinK; learnedMax = learnedMaxK;
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
                if (*posPtr >= learnedMax) {
                    Serial.printf("[VAN %d] Kich gioi han MAX co khi (%d buoc)!\n", valve, learnedMax);
                    break;
                }
                (*posPtr)++;
            } else {
                if (*posPtr <= learnedMin) {
                    Serial.printf("[VAN %d] Kich gioi han MIN co khi (%d buoc)!\n", valve, learnedMin);
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
    // Giảm xuống một tốc độ an toàn hơn (VD: 800us hoặc dùng luôn STEP_DELAY_US).
    uint32_t currentDelay = isClosingOnly ? 800 : STEP_DELAY_US;

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
        
        if (waterDone && dosingDone) {
            Serial.printf("[KẾT THÚC] Đã đạt đủ nước chính (%.1f L / Đích xả ống: %.1f L). Tắt toàn bộ hệ thống!\n", currentVolL, finalWaterTargetL);
            emergencyStop();
            digitalWrite(PUMP_PIN, LOW);
            digitalWrite(VALVE_PIN, LOW);
            systemRunning = false;
            currentPhase = 4; // Phase 4 = Completed
            publishStatus(); // Gửi báo cáo MQTT ngay lập tức để Node.js lưu DataBase
            return;
        }
    }

    // Chỉ thực thi PID châm phân khi simMode = true (Tức là chưa châm xong phân)
    if (!simMode) return;

    // Đọc thể tích tích lũy
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE_N;
    float volP = pulseP * ML_PER_PULSE_P;
    float volK = pulseK * ML_PER_PULSE_K;
    interrupts();

    // --- PHẢN HỒI DÂN DỤNG THÔNG MINH (SMART FEEDBACK 1/100) ---
    // Loại bỏ hoàn toàn lưu lượng châm cố định theo thời gian tĩnh.
    // Tốc độ châm của mỗi bồn (L/min) được tính toán động dựa theo lưu lượng thực tế ống chính
    // theo đúng tỷ lệ phối trộn 1/100, được đồng bộ theo thời gian và lưu lượng ống chính.
    float totalTargetVol = targetN + targetP + targetK;
    
    // Sử dụng bộ lọc thông thấp (exponential moving average) để làm mượt lưu lượng nước chính,
    // tránh dao động sụt áp đột ngột làm rung lắc setpoint châm phân khiến động cơ bị trượt bước.
    static float smoothMainFlowLpm = 0.0f;
    if (smoothMainFlowLpm <= 0.01f && flowLpmMain > 0.10f) {
        smoothMainFlowLpm = flowLpmMain; // Khởi tạo nhanh giá trị ban đầu
    } else if (flowLpmMain > 0.10f) {
        smoothMainFlowLpm = 0.85f * smoothMainFlowLpm + 0.15f * flowLpmMain;
    }
    
    // Đảm bảo lưu lượng nước chính tối thiểu hợp lý (ví dụ 5.0 LPM) khi có dòng chảy thực tế để giữ van luôn chạy ổn định
    float effectiveMainFlowLpm = max(5.0f, smoothMainFlowLpm);
    
    // Tổng lưu lượng phân châm cần đạt theo tỷ lệ 1/85 của nước chính để hoàn thành trước 15% nước xả rửa
    float targetTotalDosingLpm = effectiveMainFlowLpm / 85.0f;
    
    float dynTargetLpmN = 0.0f;
    float dynTargetLpmP = 0.0f;
    float dynTargetLpmK = 0.0f;

    if (totalTargetVol > 0) {
        dynTargetLpmN = (targetN / totalTargetVol) * targetTotalDosingLpm;
        dynTargetLpmP = (targetP / totalTargetVol) * targetTotalDosingLpm;
        dynTargetLpmK = (targetK / totalTargetVol) * targetTotalDosingLpm;
    }

    // Hàm lambda tính toán PID (Hiệu chỉnh tích lũy offset)
    auto calcPID = [](float targetLpm, float flowLpm, float &errSum, float &lastErr) -> int {
        if (targetLpm <= 0.0f) {
            errSum = 0.0f;
            lastErr = 0.0f;
            return 0;
        }
        // Chờ mồi dòng chảy: không chạy PID điều chỉnh khi chưa có dòng chảy thực tế
        if (flowLpm < 0.02f) {
            errSum = 0.0f;
            lastErr = 0.0f;
            return 0; // Giữ nguyên vị trí đón đầu (Feedforward)
        }
        float err = targetLpm - flowLpm;
        if (fabsf(err) <= DEADBAND_LPM) {
            return 0;
        }
        float dt = CONTROL_INTERVAL_MS / 1000.0f;
        errSum += err * dt;
        errSum = constrain(errSum, -50.0f, 50.0f);

        float dErr = (err - lastErr) / dt;
        lastErr = err;
        float output = (KP_CONTROL * err) + (KI_CONTROL * errSum) + (KD_CONTROL * dErr);
        return (int)constrain(output, -MAX_ADJ_STEPS, MAX_ADJ_STEPS);
    };
    int adjN = 0, adjP = 0, adjK = 0;
    // --- Van N ---
    if (!doneN && targetN > 0) {
        if (volN >= targetN) {
            adjN = -posN; // Đóng van N song song không chặn CPU
            doneN = true;
            // Chỉ chạy giám sát 5s nếu đây không phải là van cuối cùng kết thúc
            bool otherDone = (doneP || targetP <= 0) && (doneK || targetK <= 0);
            if (otherDone) {
                monitoringN = false;
                Serial.printf("[SIM✓] Van N đủ lượng (Van cuối) → %.0f/%.0f mL. Dừng hệ thống ngay lập tức.\n", volN, targetN);
            } else {
                monitoringN = true;
                closeTimerN = millis();
                extraCloseN = 0;
                Serial.printf("[SIM✓] Van N đủ lượng → %.0f/%.0f mL. Bắt đầu giám sát rò rỉ 5s...\n", volN, targetN);
            }
        } else {
            float volRatio = volN / targetN;
            float currentTargetLpmN = dynTargetLpmN;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f;
                scale = constrain(scale, 0.20f, 1.0f);
                currentTargetLpmN = dynTargetLpmN * scale;
            }
            if (lastSatPosN == 0 && posN > 0) {
                lastSatPosN = posN;
                lastSatFlowN = flowLpmN;
            }
            
            // 1. Tính số bước mở đón đầu (Feedforward)
            int32_t ffStepsN = (currentTargetLpmN / Q_MAX_LPM_N) * MAX_OPEN_STEPS_N;
            ffStepsN = constrain(ffStepsN, 0, MAX_OPEN_STEPS_N);
            
            // 2. Tính hiệu chỉnh phản hồi (Feedback PID)
            int adj = calcPID(currentTargetLpmN, flowLpmN, errSumN, lastErrN);
            if (volRatio >= 0.95f && flowLpmN < 0.10f && adj > 0) {
                adj = 0;
            }
            pidOffsetN = constrain(pidOffsetN + adj, -3000.0f, 3000.0f);
            
            // 3. Kết hợp Đón đầu + Phản hồi
            int32_t targetPosN = ffStepsN + (int32_t)pidOffsetN;
            targetPosN = constrain(targetPosN, learnedMinN, learnedMaxN);
            
            if (targetPosN != posN) {
                adjN = targetPosN - posN;
            }
        }
    }
    if (doneN && monitoringN) {
        if (millis() - closeTimerN < 5000) {
            if (flowLpmN > 0.01f && extraCloseN < 250 && adjN == 0) {
                adjN = -15;
                learnedMinN -= 15; // Lùi giới hạn phần mềm để cho phép siết thêm
                extraCloseN += 15;
                Serial.printf("[SIẾT VAN N] Phát hiện dòng chảy %.3f L/m -> Siết thêm 15 bước (Tổng siết: %d)\n", flowLpmN, extraCloseN);
            }
        } else {
            monitoringN = false;
            posN = 0;
            learnedMinN = 0;
            digitalWrite(EN_N, HIGH); // Tắt driver van N để hạ nhiệt
            Serial.printf("[GIÁM SÁT N] Hoàn thành. Đã reset vị trí N về 0. Siết thêm: %d bước.\n", extraCloseN);
        }
    }

    // --- Van P ---
    if (!doneP && targetP > 0) {
        if (volP >= targetP) {
            adjP = -posP; // Đóng van P song song không chặn CPU
            doneP = true;
            // Chỉ chạy giám sát 5s nếu đây không phải là van cuối cùng kết thúc
            bool otherDone = (doneN || targetN <= 0) && (doneK || targetK <= 0);
            if (otherDone) {
                monitoringP = false;
                Serial.printf("[SIM✓] Van P đủ lượng (Van cuối) → %.0f/%.0f mL. Dừng hệ thống ngay lập tức.\n", volP, targetP);
            } else {
                monitoringP = true;
                closeTimerP = millis();
                extraCloseP = 0;
                Serial.printf("[SIM✓] Van P đủ lượng → %.0f/%.0f mL. Bắt đầu giám sát rò rỉ 5s...\n", volP, targetP);
            }
        } else {
            float volRatio = volP / targetP;
            float currentTargetLpmP = dynTargetLpmP;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f;
                scale = constrain(scale, 0.20f, 1.0f);
                currentTargetLpmP = dynTargetLpmP * scale;
            }
            if (lastSatPosP == 0 && posP > 0) {
                lastSatPosP = posP;
                lastSatFlowP = flowLpmP;
            }
            
            // 1. Tính số bước mở đón đầu (Feedforward)
            int32_t ffStepsP = (currentTargetLpmP / Q_MAX_LPM_P) * MAX_OPEN_STEPS_P;
            ffStepsP = constrain(ffStepsP, 0, MAX_OPEN_STEPS_P);
            
            // 2. Tính hiệu chỉnh phản hồi (Feedback PID)
            int adj = calcPID(currentTargetLpmP, flowLpmP, errSumP, lastErrP);
            if (volRatio >= 0.95f && flowLpmP < 0.10f && adj > 0) {
                adj = 0;
            }
            pidOffsetP = constrain(pidOffsetP + adj, -2500.0f, 2500.0f);
            
            // 3. Kết hợp Đón đầu + Phản hồi
            int32_t targetPosP = ffStepsP + (int32_t)pidOffsetP;
            targetPosP = constrain(targetPosP, learnedMinP, learnedMaxP);
            
            if (targetPosP != posP) {
                adjP = targetPosP - posP;
            }
        }
    }
    if (doneP && monitoringP) {
        if (millis() - closeTimerP < 5000) {
            if (flowLpmP > 0.01f && extraCloseP < 250 && adjP == 0) {
                adjP = -15;
                learnedMinP -= 15;
                extraCloseP += 15;
                Serial.printf("[SIẾT VAN P] Phát hiện dòng chảy %.3f L/m -> Siết thêm 15 bước (Tổng siết: %d)\n", flowLpmP, extraCloseP);
            }
        } else {
            monitoringP = false;
            posP = 0;
            learnedMinP = 0;
            digitalWrite(EN_P, HIGH);
            Serial.printf("[GIÁM SÁT P] Hoàn thành. Đã reset vị trí P về 0. Siết thêm: %d bước.\n", extraCloseP);
        }
    }

    // --- Van K ---
    if (!doneK && targetK > 0) {
        if (volK >= targetK) {
            adjK = -posK; // Đóng van K song song không chặn CPU
            doneK = true;
            // Chỉ chạy giám sát 5s nếu đây không phải là van cuối cùng kết thúc
            bool otherDone = (doneN || targetN <= 0) && (doneP || targetP <= 0);
            if (otherDone) {
                monitoringK = false;
                Serial.printf("[SIM✓] Van K đủ lượng (Van cuối) → %.0f/%.0f mL. Dừng hệ thống ngay lập tức.\n", volK, targetK);
            } else {
                monitoringK = true;
                closeTimerK = millis();
                extraCloseK = 0;
                Serial.printf("[SIM✓] Van K đủ lượng → %.0f/%.0f mL. Bắt đầu giám sát rò rỉ 5s...\n", volK, targetK);
            }
        } else {
            float volRatio = volK / targetK;
            float currentTargetLpmK = dynTargetLpmK;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f;
                scale = constrain(scale, 0.20f, 1.0f);
                currentTargetLpmK = dynTargetLpmK * scale;
            }
            if (lastSatPosK == 0 && posK > 0) {
                lastSatPosK = posK;
                lastSatFlowK = flowLpmK;
            }
            
            // 1. Tính số bước mở đón đầu (Feedforward)
            int32_t ffStepsK = (currentTargetLpmK / Q_MAX_LPM_K) * MAX_OPEN_STEPS_K;
            ffStepsK = constrain(ffStepsK, 0, MAX_OPEN_STEPS_K);
            
            // 2. Tính hiệu chỉnh phản hồi (Feedback PID)
            int adj = calcPID(currentTargetLpmK, flowLpmK, errSumK, lastErrK);
            if (volRatio >= 0.95f && flowLpmK < 0.10f && adj > 0) {
                adj = 0;
            }
            pidOffsetK = constrain(pidOffsetK + adj, -2500.0f, 2500.0f);
            
            // 3. Kết hợp Đón đầu + Phản hồi
            int32_t targetPosK = ffStepsK + (int32_t)pidOffsetK;
            targetPosK = constrain(targetPosK, learnedMinK, learnedMaxK);
            
            if (targetPosK != posK) {
                adjK = targetPosK - posK;
            }
        }
    }
    if (doneK && monitoringK) {
        if (millis() - closeTimerK < 5000) {
            if (flowLpmK > 0.01f && extraCloseK < 250 && adjK == 0) {
                adjK = -15;
                learnedMinK -= 15;
                extraCloseK += 15;
                Serial.printf("[SIẾT VAN K] Phát hiện dòng chảy %.3f L/m -> Siết thêm 15 bước (Tổng siết: %d)\n", flowLpmK, extraCloseK);
            }
        } else {
            monitoringK = false;
            posK = 0;
            learnedMinK = 0;
            digitalWrite(EN_K, HIGH);
            Serial.printf("[GIÁM SÁT K] Hoàn thành. Đã reset vị trí K về 0. Siết thêm: %d bước.\n", extraCloseK);
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
        // Reset pulse counters và PID state
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
        errSumN = errSumP = errSumK = 0.0f;
        lastErrN = lastErrP = lastErrK = 0.0f;
        pidOffsetN = pidOffsetP = pidOffsetK = 0.0f;
        Serial.printf("[SIM] N=%.0fmL@%.2fL/m | P=%.0fmL@%.2fL/m | K=%.0fmL@%.2fL/m\n",
                       targetN, targetLpmN,
                       targetP, targetLpmP,
                       targetK, targetLpmK);
        simMode = true;
        systemRunning = true;
        currentPhase  = 100;  // 100 = chế độ đồng thời
        zeroFlowDuration = 0;
        systemError = "";      
        // Bật Bơm và Van chính để nước chảy qua hệ thống phối trộn đồng thời
        if (targetN > 0 || targetP > 0 || targetK > 0 || targetTotalWaterL > 0.0f) {
            Serial.println("[SIM] Đang kích hoạt mở Van chính (chờ 5 giây để van mở hoàn toàn)...");
            digitalWrite(VALVE_PIN, HIGH);
            delay(5000); // Đợi 5 giây cho van điện từ mở hoàn toàn           
            Serial.println("[SIM] Đang khởi động Bơm chính...");
            digitalWrite(PUMP_PIN, HIGH);
            delay(1000); // Đợi 1 giây cho dòng khởi động ổn định trước khi bắt đầu vòng điều khiển hồi tiếp
            // Mở nhanh ban đầu đồng thời theo tỷ lệ thể tích mục tiêu để tránh chảy quá (giảm bước mở với thể tích nhỏ)
            int initN = targetN > 0 ? ((targetN < 200.0f) ? max(150, (int)(targetN * (INITIAL_STARTUP_STEPS_N / 200.0f))) : INITIAL_STARTUP_STEPS_N) : 0;
            int initP = targetP > 0 ? ((targetP < 200.0f) ? max(150, (int)(targetP * (INITIAL_STARTUP_STEPS_P / 200.0f))) : INITIAL_STARTUP_STEPS_P) : 0;
            int initK = targetK > 0 ? ((targetK < 200.0f) ? max(150, (int)(targetK * (INITIAL_STARTUP_STEPS_K / 200.0f))) : INITIAL_STARTUP_STEPS_K) : 0;
            if (initN > 0 || initP > 0 || initK > 0) {
                moveSteppersSimultaneous(initN, initP, initK);
            }
        }       
        lastControlTime = millis();
        runStartTime = millis();        
        Serial.println("[SIM] Tất cả van đã mở - vòng điều khiển PID bắt đầu!");
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
// KIỂM TRA XEM KÊNH ĐANG HOẠT ĐỘNG CÓ BỊ KHÔNG CÓ LƯU LƯỢNG (CHẠY KHÔ) KHÔNG
bool isZeroFlowActive() {
    if (!systemRunning) return false;   
    // Kiểm tra xem các kênh chưa hoàn thành có bị tắc lưu lượng (lưu lượng < 0.02 LPM) không
    bool anyActiveAndZero = false;
    if (targetN > 0 && !doneN && flowLpmN < 0.02f) anyActiveAndZero = true;
    if (targetP > 0 && !doneP && flowLpmP < 0.02f) anyActiveAndZero = true;
    if (targetK > 0 && !doneK && flowLpmK < 0.02f) anyActiveAndZero = true;
    return anyActiveAndZero;
}

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

    // Kiểm tra bảo vệ chống chạy khô (Flow Timeout)
    if (systemRunning) {
        if (now - runStartTime > FLOW_GRACE_PERIOD_MS) {
            if (isZeroFlowActive()) {
                zeroFlowDuration += (unsigned long)(dt_s * 1000.0f); // Cộng dồn thời gian thực tế trôi qua (ms)
                if (zeroFlowDuration >= FLOW_TIMEOUT_MS) {
                    Serial.printf("\n[CẢNH BÁO] !!! PHÁT HIỆN HỆ THỐNG CHẠY KHÔ (KHÔNG CÓ LƯU LƯỢNG PHÂN QUÁ %d GIÂY) !!!\n", FLOW_TIMEOUT_MS / 1000);
                    systemError = "FLOW_TIMEOUT";
                    emergencyStop();
                    publishStatus(); // Publish cập nhật trạng thái lỗi ngay lập tức
                }
            } else {
                zeroFlowDuration = 0; // Reset nếu có lưu lượng bình thường
            }
        }
    } else {
        zeroFlowDuration = 0;
    }
    lastFlowCalc = now;
}

//====================================================================================================================================================================================================================
// ĐÓNG CHẶT VAN HỒI TIẾP (CLOSED-LOOP CLOSED VALVE FEEDBACK CORRECTION)
// Di chuyển động cơ bước thêm cho đến khi cảm biến lưu lượng thực sự báo 0 L/phút
void forceCloseValve(int valve) {
    Serial.printf("[FORCE CLOSE] Bat dau dong chat van %d su dung phan hoi cam bien...\n", valve);   
    // 1. Di chuyển về vị trí 0 (đóng theo ly thuyet so buoc tinh toan)
    openValve(valve, 0);    
    // Giu driver ENABLE (LOW) de co mo-men xoan trong qua trinh siet chat van
    uint8_t stepPin, dirPin, enPin;
    float currentFlow = 0.0f;
    int32_t *posPtr = nullptr;
    int32_t *learnedMinPtr = nullptr;   
    switch (valve) {
        case 1: 
            stepPin = STEP_N; dirPin = DIR_N; enPin = EN_N; 
            posPtr = &posN; learnedMinPtr = &learnedMinN;
            break;
        case 2: 
            stepPin = STEP_P; dirPin = DIR_P; enPin = EN_P; 
            posPtr = &posP; learnedMinPtr = &learnedMinP;
            break;
        case 3: 
            stepPin = STEP_K; dirPin = DIR_K; enPin = EN_K; 
            posPtr = &posK; learnedMinPtr = &learnedMinK;
            break;
        default: return;
    }   
    // Đảm bảo driver được kích hoạt (ENABLE = LOW)
    digitalWrite(enPin, LOW);   
    // 2. Cho 800ms de dong chay on dinh va tinh luu luong ban dau sau khi dong ly thuyet
    delay(800);
    calculateFlowRates();   
    switch (valve) {
        case 1: currentFlow = flowLpmN; break;
        case 2: currentFlow = flowLpmP; break;
        case 3: currentFlow = flowLpmK; break;
    }   
    Serial.printf("[FORCE CLOSE] Luu luong ban dau sau khi dong ly thuyet: %.3f L/phut\n", currentFlow);
    
    // THOÁT SỚM NẾU DÒNG CHẢY ĐÃ VỀ 0 (CHỐNG KẸT VAN)
    if (currentFlow <= 0.01f) {
        Serial.printf("[FORCE CLOSE] -> Van %d da kin hoan toan tai vi tri 0 (Flow = 0). Ket thuc som!\n", valve);
        digitalWrite(enPin, HIGH); // Tắt driver (ngắt điện) để tiết kiệm điện
        return;
    }    
    int extraStepsApplied = 0;
    const int MAX_EXTRA_STEPS = 250; // Gioi han an toan toi da 250 buoc siet co (tranh hong ren van)
    const int STEP_INCREMENT = 15;  // Moi lan siet them 15 buoc cực nhỏ để tránh kẹt
    const int CHECK_DELAY_MS = 800; // Thoi gian cho dong chay cap nhat sau moi lan siet    
    int unchangedFlowCount = 0;
    float lastFlow = currentFlow;   
    // 3. Vong hoi tiep siet chat: Siet them tung chut mot neu van phat hien dong chay
    while (currentFlow > 0.01f && extraStepsApplied < MAX_EXTRA_STEPS) {
        Serial.printf("[FORCE CLOSE] Phat hien ro ri (%.3f L/m) -> Siet chat them %d buoc...\n", currentFlow, STEP_INCREMENT);      
        // Di chuyen them theo huong dong (DIR = LOW, tuc la moveStepper truyen steps am)
        moveStepper(valve, -STEP_INCREMENT);
        extraStepsApplied += STEP_INCREMENT;       
        // Cap nhat lai vi tri luu tru thuc te trong ram (vi pos giam di khi siet them)
        if (posPtr) *posPtr -= STEP_INCREMENT;        
        // Cho va tinh lai luu luong
        delay(CHECK_DELAY_MS);
        calculateFlowRates();       
        lastFlow = currentFlow;
        switch (valve) {
            case 1: currentFlow = flowLpmN; break;
            case 2: currentFlow = flowLpmP; break;
            case 3: currentFlow = flowLpmK; break;
        }        
        // MÁY HỌC TỰ PHÁT HIỆN KẸT: Nếu siết tiếp mà lưu lượng không đổi/tăng lên, chứng tỏ đã chạm kịch điểm cơ khí
        if (fabsf(lastFlow - currentFlow) < 0.002f || currentFlow >= lastFlow) {
            unchangedFlowCount++;
            if (unchangedFlowCount >= 2) {
                if (learnedMinPtr && posPtr) {
                    *learnedMinPtr = *posPtr;
                    Serial.printf("[ML] Da cham kich điểm co khí! Hoc vi tri MIN cho Bon %d la: %d buoc\n", valve, *learnedMinPtr);
                }
                break; // Thoát vòng lặp để tránh kẹt động cơ
            }
        } else {
            unchangedFlowCount = 0;
        }
    }   
    if (currentFlow <= 0.01f) {
        Serial.printf("[FORCE CLOSE] -> Da dung hoan toan dong chay bon %d! (Siet them: %d buoc)\n", valve, extraStepsApplied);
        if (learnedMinPtr && posPtr) {
            *learnedMinPtr = *posPtr; // Lưu lại vị trí đóng hoàn toàn làm MIN
        }
    } else {
        Serial.printf("[FORCE CLOSE] [!] Canh bao: Da dat gioi han siet hoac kich diem (%d buoc) nhung dong chay van con %.3f L/m!\n", extraStepsApplied, currentFlow);
    }  
    // 4. Hoan thanh: Tat driver (ENABLE = HIGH) de bao ve dong co, giam nhiet do
    digitalWrite(enPin, HIGH);
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
