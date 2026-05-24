#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// CẤU HÌNH WIFI & MQTT
const char* WIFI_SSID     = "huuduc";       // Điền tên WiFi ở Nhà lưới vào đây
const char* WIFI_PASSWORD = "19052004";     // Điền mật khẩu WiFi ở Nhà lưới vào đây
const char* MQTT_SERVER   = "broker.hivemq.com"; // Sử dụng Cloud MQTT
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";    // Để trống nếu không dùng xác thực
const char* MQTT_PASS     = "";

// CHÂN GPIO - ĐỘNG CƠ BƯỚC

//BỒN 1
#define STEP_N     13
#define DIR_N      14
#define EN_N       15

//BỒN 2
#define STEP_P     16
#define DIR_P      17
#define EN_P       18

//BỒN 3
#define STEP_K     19
#define DIR_K      21
#define EN_K       22

// CHÂN GPIO - CẢM BIẾN LƯU LƯỢNG 
#define FLOW_N     25
#define FLOW_P     26
#define FLOW_K     27
#define FLOW_MAIN  33

// CHÂN GPIO - BƠM VÀ VAN CHÍNH
#define PUMP_PIN   4
#define VALVE_PIN  5

// LED trạng thái
#define STATUS_LED  2

// THÔNG SỐ PHẦN CỨNG
// NEMA 17: 200 bước/vòng (1.8°/bước)
// A4988: chế độ vi bước 1/8 → 1600 micro-bước/vòng
// MAX_OPEN_STEPS: Đóng hoàn toàn đến mở hoàn toàn van kim = 8500 bước (~5.3 vòng)
#define STEPS_PER_REV   200
#define MICROSTEP       8
#define MAX_OPEN_STEPS  8500   // Khoảng 8500 bước vi bước 1/8 từ đóng hoàn toàn (min) đến mở hoàn toàn (max)

// Độ trễ giữa các micro-bước (µs) - giảm để nhanh hơn, tăng để an toàn hơn
#define STEP_DELAY_US   500   // 500us per micro-step edge (tăng từ 300 lên 500 để tăng lực kéo mô-men xoắn khi chịu tải)

// YF-S401 Flow Sensor:
//   Đặc tính: F(Hz) = 98 × Q(L/min)
//   Thể tích mỗi xung = 1 / (98 × 60) L = 0.170 mL/xung
#define ML_PER_PULSE    0.170f

// Chu kỳ publish và tính flow rate (ms)
#define PUBLISH_INTERVAL    500
#define FLOW_CALC_INTERVAL  1000

// THÔNG SỐ ĐIỀU KHIỂN PHẢN HỒI (PID-Controller)
// Q_MAX_LPM: Lưu lượng tối đa (L/phút) khi van mở hoàn toàn.
//   *** ĐO THỰC NGHIỆM rồi chỉnh giá trị này! ***
//   Cách đo: mở van 100%, đặt bình 1 lít, bấm giờ → Q_max = 1/thời_gian_phút
#define Q_MAX_LPM       4.0f

#define KP_CONTROL     35.0f   // Hệ số tỉ lệ (Proportional)
#define KI_CONTROL      8.0f   // Hệ số tích phân (Integral)
#define KD_CONTROL      5.0f   // Hệ số vi phân (Derivative)

// Vùng chết: bỏ qua sai số nhỏ hơn giá trị này (L/phút)
#define DEADBAND_LPM    0.05f

// Số bước tối đa điều chỉnh mỗi chu kỳ (tăng lên 150 để phản hồi nhạy bén)
#define MAX_ADJ_STEPS   150

// Chu kỳ vòng điều khiển (ms)
#define CONTROL_INTERVAL_MS  1000

// Biến lưu trạng thái PID cho từng van
float errSumN = 0.0f, errSumP = 0.0f, errSumK = 0.0f;
float lastErrN = 0.0f, lastErrP = 0.0f, lastErrK = 0.0f;

// Số bước mở nhanh ban đầu khi khởi động (khoảng 1000 bước 1/8)
#define INITIAL_STARTUP_STEPS  1000
// Điểm bắt đầu giảm tốc khi đóng van
#define SLOW_CLOSE_THRESHOLD_STEPS  1200

// BIẾN TOÀN CỤC

// --- Bộ đếm xung cảm biến (PHẢI khai báo volatile vì dùng trong ISR) ---
volatile uint32_t pulseN = 0;
volatile uint32_t pulseP = 0;
volatile uint32_t pulseK = 0;
volatile uint32_t pulseMain = 0;

// Snapshot để tính flow rate
uint32_t snapPulseN = 0, snapPulseP = 0, snapPulseK = 0, snapPulseMain = 0;
float    flowLpmN = 0.0f, flowLpmP = 0.0f, flowLpmK = 0.0f, flowLpmMain = 0.0f;

// Mục tiêu thể tích (mL)
float targetN = 0.0f, targetP = 0.0f, targetK = 0.0f;

// Phần trăm mở van (0-100) - dùng cho chế độ tuần tự
int speedN = 60, speedP = 60, speedK = 60;

// Vị trí hiện tại của van (số micro-bước từ vị trí đóng)
int32_t posN = 0, posP = 0, posK = 0;

// GIỚI HẠN GÓC XOAY BAN ĐẦU (STARTUP CLAMP)
#define STARTUP_LIMIT_STEPS 2000

// BIẾN MÁY HỌC TỰ CÂN CHỈNH GIỚI HẠN AN TOÀN (SELF-LEARNING BOUNDARIES)
int32_t learnedMinN = 0, learnedMaxN = MAX_OPEN_STEPS;
int32_t learnedMinP = 0, learnedMaxP = MAX_OPEN_STEPS;
int32_t learnedMinK = 0, learnedMaxK = MAX_OPEN_STEPS;

// Theo dõi vị trí và lưu lượng để học độ bão hòa (saturating open limit)
int32_t lastSatPosN = 0, lastSatPosP = 0, lastSatPosK = 0;
float lastSatFlowN = 0.0f, lastSatFlowP = 0.0f, lastSatFlowK = 0.0f;

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
// ĐIỀU KHIỂN ĐỘNG CƠ BƯỚC
// Di chuyển stepper motor một số bước chỉ định của van tương ứng (1 = N, 2 = P, 3 = K).
// steps > 0 → hướng mở van
// steps < 0 → hướng đóng van
void moveStepper(int valve, int steps) {
    if (steps == 0) return;

    uint8_t stepPin, dirPin, enPin;
    int32_t *posPtr = nullptr;
    int32_t learnedMin = 0, learnedMax = MAX_OPEN_STEPS;

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

    digitalWrite(enPin, LOW);   // Kích hoạt driver (ENABLE tích cực mức THẤP)
    delayMicroseconds(2);       // Trễ setup

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

// Mở van đến phần trăm mong muốn (0% = đóng, 100% = mở hoàn toàn).
void openValve(int valve, int percent) {
    int targetSteps = (MAX_OPEN_STEPS * constrain(percent, 0, 100)) / 100;
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
//Đóng hoàn toàn một van và tắt driver để tiết kiệm điện.
void closeValve(int valve) {
    openValve(valve, 0);
    switch (valve) {
        case 1: digitalWrite(EN_N, HIGH); break;
        case 2: digitalWrite(EN_P, HIGH); break;
        case 3: digitalWrite(EN_K, HIGH); break;
    }
}
// Dừng khẩn cấp: Tắt toàn bộ thiết bị ngay lập tức (không xoay động cơ bước về 0).
void emergencyStop() {
    Serial.println("\n!!! DỪNG KHẨN CẤP - Ngắt toàn bộ thiết bị ngay lập tức !!!\n");
    systemRunning = false;
    currentPhase  = 0;
    simMode       = false;
    doneN = doneP = doneK = false;
    
    // Tắt Bơm và Van điện từ chính ngay lập tức để ngắt dòng chảy
    digitalWrite(PUMP_PIN, LOW);
    digitalWrite(VALVE_PIN, LOW);
    
    // Vô hiệu hóa và ngắt điện hoàn toàn driver 3 động cơ bước ngay lập tức (giữ nguyên vị trí)
    digitalWrite(EN_N, HIGH);
    digitalWrite(EN_P, HIGH);
    digitalWrite(EN_K, HIGH);
}
// MQTT CALLBACK - Nhận lệnh từ server
// ĐIỀU KHIỂN TỈ LỆ - CHẠY ĐỒNG THỜI (P-Controller)
// Gọi trong loop() mỗi CONTROL_INTERVAL_MS ms
void controlSimultaneous() {
    // Đọc thể tích tích lũy
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE;
    float volP = pulseP * ML_PER_PULSE;
    float volK = pulseK * ML_PER_PULSE;
    interrupts();

    // Hàm lambda tính toán PID
    auto calcPID = [](float targetLpm, float flowLpm, float &errSum, float &lastErr) -> int {
        if (targetLpm <= 0.0f) {
            errSum = 0.0f;
            lastErr = 0.0f;
            return 0;
        }

        float err = targetLpm - flowLpm;

        // Giai đoạn 1: Mở nhanh để mồi dòng chảy khi cảm biến chưa phát hiện dòng chảy
        if (flowLpm < 0.02f) {
            errSum = 0.0f;
            lastErr = err;
            return 100; // Mở nhanh +100 bước mỗi chu kỳ
        }

        // Giai đoạn 2: Điều khiển PID ổn định dòng chảy
        if (fabsf(err) <= DEADBAND_LPM) {
            return 0; // Nằm trong vùng chết thì giữ nguyên vị trí van
        }

        float dt = CONTROL_INTERVAL_MS / 1000.0f;
        errSum += err * dt;
        errSum = constrain(errSum, -50.0f, 50.0f); // Chống bão hòa tích phân (Anti-windup)

        float dErr = (err - lastErr) / dt;
        lastErr = err;

        float output = (KP_CONTROL * err) + (KI_CONTROL * errSum) + (KD_CONTROL * dErr);
        return (int)constrain(output, -MAX_ADJ_STEPS, MAX_ADJ_STEPS);
    };

    // --- Van N ---
    if (!doneN && targetN > 0) {
        if (volN >= targetN) {
            forceCloseValve(1);
            doneN = true;
            Serial.printf("[SIM✓] Van N đủ lượng → %.0f/%.0f mL\n", volN, targetN);
        } else {
            // Giảm dần lưu lượng mục tiêu khi đạt trên 90% thể tích để đóng van êm ái
            float volRatio = volN / targetN;
            float currentTargetLpmN = targetLpmN;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f; // từ 1.0 giảm về 0.0
                scale = constrain(scale, 0.20f, 1.0f);   // Giữ tối thiểu 20% tránh dừng van hẳn
                currentTargetLpmN = targetLpmN * scale;
            }

            if (lastSatPosN == 0 && posN > 0) {
                lastSatPosN = posN;
                lastSatFlowN = flowLpmN;
            }

            int adj = calcPID(currentTargetLpmN, flowLpmN, errSumN, lastErrN);
            int newPos = constrain(posN + adj, learnedMinN, learnedMaxN);

            if (newPos != posN) {
                // Tự học bão hòa cơ khí
                if (adj > 0 && (newPos - lastSatPosN) >= 150) {
                    float flowDiff = flowLpmN - lastSatFlowN;
                    if (flowDiff < 0.02f) {
                        learnedMaxN = posN;
                        Serial.printf("[ML] Phát hiện bão hòa! Giới hạn MAX N học được: %d bước\n", learnedMaxN);
                        newPos = posN;
                    } else {
                        lastSatPosN = newPos;
                        lastSatFlowN = flowLpmN;
                    }
                }

                if (newPos != posN) {
                    moveStepper(1, newPos - posN);
                    Serial.printf("[N] Flow=%.3f (Tgt=%.3f) → PID Adj=%+d → Pos=%d steps (Min=%d, Max=%d)\n",
                                  flowLpmN, currentTargetLpmN, adj, posN, learnedMinN, learnedMaxN);
                }
            }
        }
    }

    // --- Van P ---
    if (!doneP && targetP > 0) {
        if (volP >= targetP) {
            forceCloseValve(2);
            doneP = true;
            Serial.printf("[SIM✓] Van P đủ lượng → %.0f/%.0f mL\n", volP, targetP);
        } else {
            // Giảm dần lưu lượng mục tiêu khi đạt trên 90% thể tích để đóng van êm ái
            float volRatio = volP / targetP;
            float currentTargetLpmP = targetLpmP;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f;
                scale = constrain(scale, 0.20f, 1.0f);
                currentTargetLpmP = targetLpmP * scale;
            }

            if (lastSatPosP == 0 && posP > 0) {
                lastSatPosP = posP;
                lastSatFlowP = flowLpmP;
            }

            int adj = calcPID(currentTargetLpmP, flowLpmP, errSumP, lastErrP);
            int newPos = constrain(posP + adj, learnedMinP, learnedMaxP);

            if (newPos != posP) {
                if (adj > 0 && (newPos - lastSatPosP) >= 150) {
                    float flowDiff = flowLpmP - lastSatFlowP;
                    if (flowDiff < 0.02f) {
                        learnedMaxP = posP;
                        Serial.printf("[ML] Phát hiện bão hòa! Giới hạn MAX P học được: %d bước\n", learnedMaxP);
                        newPos = posP;
                    } else {
                        lastSatPosP = newPos;
                        lastSatFlowP = flowLpmP;
                    }
                }

                if (newPos != posP) {
                    moveStepper(2, newPos - posP);
                    Serial.printf("[P] Flow=%.3f (Tgt=%.3f) → PID Adj=%+d → Pos=%d steps (Min=%d, Max=%d)\n",
                                  flowLpmP, currentTargetLpmP, adj, posP, learnedMinP, learnedMaxP);
                }
            }
        }
    }

    // --- Van K ---
    if (!doneK && targetK > 0) {
        if (volK >= targetK) {
            forceCloseValve(3);
            doneK = true;
            Serial.printf("[SIM✓] Van K đủ lượng → %.0f/%.0f mL\n", volK, targetK);
        } else {
            // Giảm dần lưu lượng mục tiêu khi đạt trên 90% thể tích để đóng van êm ái
            float volRatio = volK / targetK;
            float currentTargetLpmK = targetLpmK;
            if (volRatio >= 0.90f) {
                float scale = (1.0f - volRatio) / 0.10f;
                scale = constrain(scale, 0.20f, 1.0f);
                currentTargetLpmK = targetLpmK * scale;
            }

            if (lastSatPosK == 0 && posK > 0) {
                lastSatPosK = posK;
                lastSatFlowK = flowLpmK;
            }

            int adj = calcPID(currentTargetLpmK, flowLpmK, errSumK, lastErrK);
            int newPos = constrain(posK + adj, learnedMinK, learnedMaxK);

            if (newPos != posK) {
                if (adj > 0 && (newPos - lastSatPosK) >= 150) {
                    float flowDiff = flowLpmK - lastSatFlowK;
                    if (flowDiff < 0.02f) {
                        learnedMaxK = posK;
                        Serial.printf("[ML] Phát hiện bão hòa! Giới hạn MAX K học được: %d bước\n", learnedMaxK);
                        newPos = posK;
                    } else {
                        lastSatPosK = newPos;
                        lastSatFlowK = flowLpmK;
                    }
                }

                if (newPos != posK) {
                    moveStepper(3, newPos - posK);
                    Serial.printf("[K] Flow=%.3f (Tgt=%.3f) → PID Adj=%+d → Pos=%d steps (Min=%d, Max=%d)\n",
                                  flowLpmK, currentTargetLpmK, adj, posK, learnedMinK, learnedMaxK);
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
        digitalWrite(PUMP_PIN, LOW);
        digitalWrite(VALVE_PIN, LOW);
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
        zeroFlowDuration = 0;
        systemError = "";

        // Bật Bơm và Van chính để nước chảy qua hệ thống phối trộn
        if (targetN > 0 || targetP > 0 || targetK > 0) {
            Serial.println("[>] Đang kích hoạt mở Van chính (chờ 5 giây để van mở hoàn toàn)...");
            digitalWrite(VALVE_PIN, HIGH);
            delay(5000); // Đợi 5 giây cho van điện từ mở hoàn toàn
            
            Serial.println("[>] Đang khởi động Bơm chính...");
            digitalWrite(PUMP_PIN, HIGH);
            delay(1000); // Đợi 1 giây cho dòng khởi động của Bơm ổn định để tránh sụt áp động cơ bước
        }

        // Cập nhật runStartTime sau khi bơm đã thực sự hoạt động
        runStartTime = millis();

        // Bắt đầu pha đầu tiên có target > 0, mở nhanh INITIAL_STARTUP_STEPS bước góc 1/8
        if (targetN > 0) {
            currentPhase = 1;
            moveStepper(1, INITIAL_STARTUP_STEPS);
            Serial.printf("[>] Bắt đầu pha N (mở nhanh ban đầu %d bước)\n", INITIAL_STARTUP_STEPS);
        } else if (targetP > 0) {
            currentPhase = 2;
            moveStepper(2, INITIAL_STARTUP_STEPS);
            Serial.printf("[>] Bắt đầu pha P (mở nhanh ban đầu %d bước)\n", INITIAL_STARTUP_STEPS);
        } else if (targetK > 0) {
            currentPhase = 3;
            moveStepper(3, INITIAL_STARTUP_STEPS);
            Serial.printf("[>] Bắt đầu pha K (mở nhanh ban đầu %d bước)\n", INITIAL_STARTUP_STEPS);
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

        // Reset vị trí về 0 nhưng sau đó sẽ chủ động mở nhanh ban đầu
        posN = 0;
        posP = 0;
        posK = 0;

        // Reset các mốc học bão hòa cho chu kỳ mới
        lastSatPosN = 0; lastSatPosP = 0; lastSatPosK = 0;
        lastSatFlowN = 0.0f; lastSatFlowP = 0.0f; lastSatFlowK = 0.0f;

        // Reset pulse counters và PID state
        noInterrupts(); pulseN = pulseP = pulseK = 0; interrupts();
        snapPulseN = snapPulseP = snapPulseK = 0;
        doneN = doneP = doneK = false;

        errSumN = errSumP = errSumK = 0.0f;
        lastErrN = lastErrP = lastErrK = 0.0f;

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
        if (targetN > 0 || targetP > 0 || targetK > 0) {
            Serial.println("[SIM] Đang kích hoạt mở Van chính (chờ 5 giây để van mở hoàn toàn)...");
            digitalWrite(VALVE_PIN, HIGH);
            delay(5000); // Đợi 5 giây cho van điện từ mở hoàn toàn
            
            Serial.println("[SIM] Đang khởi động Bơm chính...");
            digitalWrite(PUMP_PIN, HIGH);
            delay(1000); // Đợi 1 giây cho dòng khởi động ổn định trước khi bắt đầu vòng điều khiển hồi tiếp

            // Mở nhanh ban đầu 1000 bước vi bước 1/8 để tạo dòng chảy cho cảm biến nhận tín hiệu
            if (targetN > 0) moveStepper(1, INITIAL_STARTUP_STEPS);
            if (targetP > 0) moveStepper(2, INITIAL_STARTUP_STEPS);
            if (targetK > 0) moveStepper(3, INITIAL_STARTUP_STEPS);
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
                    digitalWrite(enPin, HIGH); // Tắt driver
                }
            };

            smartHome(1, posN, EN_N);
            smartHome(2, posP, EN_P);
            smartHome(3, posK, EN_K);

            Serial.println("[HOME] Đã reset động cơ về vị trí gốc an toàn.");
        }
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
// KIỂM TRA XEM KÊNH ĐANG HOẠT ĐỘNG CÓ BỊ KHÔNG CÓ LƯU LƯỢNG (CHẠY KHÔ) KHÔNG
bool isZeroFlowActive() {
    if (!systemRunning) return false;
    
    if (simMode) {
        // Trong chế độ đồng thời, kiểm tra xem các kênh chưa hoàn thành có bị tắc lưu lượng (lưu lượng < 0.02 LPM) không
        bool anyActiveAndZero = false;
        if (targetN > 0 && !doneN && flowLpmN < 0.02f) anyActiveAndZero = true;
        if (targetP > 0 && !doneP && flowLpmP < 0.02f) anyActiveAndZero = true;
        if (targetK > 0 && !doneK && flowLpmK < 0.02f) anyActiveAndZero = true;
        return anyActiveAndZero;
    } else {
        // Trong chế độ tuần tự, kiểm tra kênh hiện tại đang chạy có bị tắc lưu lượng không
        if (currentPhase == 1 && targetN > 0 && flowLpmN < 0.02f) return true;
        if (currentPhase == 2 && targetP > 0 && flowLpmP < 0.02f) return true;
        if (currentPhase == 3 && targetK > 0 && flowLpmK < 0.02f) return true;
    }
    return false;
}

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
 // YF-S401: Q(L/min) = F(Hz) / 98  →  Q = (xung/dt_s) / 98
    flowLpmN = (dN / dt_s) / 98.0f;
    flowLpmP = (dP / dt_s) / 98.0f;
    flowLpmK = (dK / dt_s) / 98.0f;
    flowLpmMain = (dMain / dt_s) / 98.0f;

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
    
    // Đảm bảo driver vẫn kích hoạt (ENABLE = LOW)
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
        digitalWrite(enPin, HIGH); // Tắt driver để tiết kiệm điện
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

// XỬ LÝ LOGIC BƠM (gọi liên tục trong loop)
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
                forceCloseValve(1); // Thay thế closeValve(1) để siết chặt van dựa trên cảm biến phản hồi
                Serial.printf("[✓] Pha N hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volN, targetN);
                if (targetP > 0) {
                    currentPhase = 2;
                    moveStepper(2, INITIAL_STARTUP_STEPS);
                    Serial.printf("[>] Chuyển sang pha P (mở nhanh ban đầu %d bước)...\n", INITIAL_STARTUP_STEPS);
                } else if (targetK > 0) {
                    currentPhase = 3;
                    moveStepper(3, INITIAL_STARTUP_STEPS);
                    Serial.printf("[>] Chuyển sang pha K (mở nhanh ban đầu %d bước)...\n", INITIAL_STARTUP_STEPS);
                } else {
                    currentPhase = 4;
                    systemRunning = false;
                    digitalWrite(PUMP_PIN, LOW);
                    digitalWrite(VALVE_PIN, LOW);
                    Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
                }
            }
            break;

        case 2:  // Đang bơm P
            if (volP >= targetP) {
                forceCloseValve(2); // Thay thế closeValve(2) để siết chặt van dựa trên cảm biến phản hồi
                Serial.printf("[✓] Pha P hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volP, targetP);
                if (targetK > 0) {
                    currentPhase = 3;
                    moveStepper(3, INITIAL_STARTUP_STEPS);
                    Serial.printf("[>] Chuyển sang pha K (mở nhanh ban đầu %d bước)...\n", INITIAL_STARTUP_STEPS);
                } else {
                    currentPhase = 4;
                    systemRunning = false;
                    digitalWrite(PUMP_PIN, LOW);
                    digitalWrite(VALVE_PIN, LOW);
                    Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
                }
            }
            break;

        case 3:  // Đang bơm K
            if (volK >= targetK) {
                forceCloseValve(3); // Thay thế closeValve(3) để siết chặt van dựa trên cảm biến phản hồi
                currentPhase  = 4;
                systemRunning = false;
                digitalWrite(PUMP_PIN, LOW);
                digitalWrite(VALVE_PIN, LOW);
                Serial.printf("[✓] Pha K hoàn thành → đã bơm %.1f mL (mục tiêu: %.1f mL)\n",
                              volK, targetK);
                Serial.println("[✓✓] Hoàn thành toàn bộ quá trình pha trộn!");
            }
            break;
    }
}
// PUBLISH TRẠNG THÁI LÊN MQTT
void publishStatus() {
    noInterrupts();
    float volN = pulseN * ML_PER_PULSE;
    float volP = pulseP * ML_PER_PULSE;
    float volK = pulseK * ML_PER_PULSE;
    float volMain = pulseMain * ML_PER_PULSE;
    interrupts();

    JsonDocument doc;
    doc["ts"]        = (uint32_t)millis();
    doc["running"]   = systemRunning;
    doc["phase"]     = currentPhase;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["error"]     = systemError;

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

    doc["main_flow_lpm"] = roundf(flowLpmMain * 100.0f) / 100.0f;
    doc["main_volume_ml"] = roundf(volMain);
    doc["total_target_ml"] = targetN + targetP + targetK;
    doc["total_volume_ml"] = volN + volP + volK;

    char buffer[700];
    size_t len = serializeJson(doc, buffer);
    mqttClient.publish(TOPIC_STATUS, (uint8_t*)buffer, len, false);
}
// SETUP
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

    // Giả định van đã đóng sẵn từ trước để chống kẹt xung khi bật nguồn
    Serial.println(F("[INIT] Khởi tạo vị trí van kim về vị trí 0 (đã đóng)..."));
    posN = 0; posP = 0; posK = 0;
    digitalWrite(EN_N, HIGH); // Tắt driver để tiết kiệm điện và giảm nóng động cơ
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
