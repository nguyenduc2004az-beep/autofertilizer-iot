# 🌱 AutoFertilizer - Hệ Thống Phối Trộn Phân Tự Động

**Luận văn tốt nghiệp 2026** | ESP32 + Stepper Motor + Flow Sensor + Web Dashboard

---

## 📁 Cấu Trúc Dự Án

```
du_an_web/
├── esp32/
│   └── fertilizer_system/
│       └── fertilizer_system.ino    ← Firmware ESP32 (Arduino IDE)
│
├── server/
│   ├── package.json                 ← Node.js dependencies
│   ├── server.js                    ← Backend server (MQTT + Express + Socket.io)
│   └── db.json                      ← Database (tự tạo khi khởi động)
│
├── public/
│   ├── index.html                   ← Web Dashboard
│   ├── css/style.css                ← Stylesheet
│   └── js/app.js                    ← Frontend JavaScript
│
└── README.md
```

---

## 🔧 Phần Cứng (Hardware)

| STT | Linh kiện | Số lượng | Ghi chú |
|-----|-----------|----------|---------|
| 1 | ESP32 DevKit V1 | 1 | Vi điều khiển chính |
| 2 | Động cơ bước NEMA 17 | 3 | 200 step/rev, 1.8°/step |
| 3 | Driver A4988 / DRV8825 | 3 | Điều khiển stepper |
| 4 | Van kim (Needle Valve) | 3 | Van N, P, K |
| 5 | Cảm biến lưu lượng YF-S201 | 3 | 1 cảm biến/van |
| 6 | Nguồn 12V DC | 1 | Cấp cho stepper motor |
| 7 | Module DC-DC (12V→5V) | 1 | Cấp cho ESP32 |

### Sơ đồ kết nối ESP32

```
ESP32 GPIO → Driver A4988
━━━━━━━━━━━━━━━━━━━━━━━━━━
Van N (Đạm):
  GPIO 13 → STEP
  GPIO 14 → DIR
  GPIO 15 → ENABLE (active LOW)

Van P (Lân):
  GPIO 16 → STEP
  GPIO 17 → DIR
  GPIO 18 → ENABLE

Van K (Kali):
  GPIO 19 → STEP
  GPIO 21 → DIR
  GPIO 22 → ENABLE

Cảm biến lưu lượng YF-S201:
  GPIO 25 → Signal (Van N)
  GPIO 26 → Signal (Van P)
  GPIO 27 → Signal (Van K)
  GND     → GND
  5V      → VCC

A4988 Driver:
  VMOT (12V) ← Nguồn 12V
  VDD  (5V)  ← 5V ESP32
  GND        ← GND chung
  MS1/MS2/MS3 ← Cài microstepping (xem bảng)
```

### Cài đặt Microstepping A4988

| MS1 | MS2 | MS3 | Chế độ |
|-----|-----|-----|--------|
| L | L | L | Full step (200 step/rev) |
| H | L | L | 1/2 step (400 step/rev) |
| L | H | L | 1/4 step (800 step/rev) |
| H | H | L | **1/8 step (1600 step/rev)** ← Mặc định trong code |
| H | H | H | 1/16 step (3200 step/rev) |

---

## 💻 Cài Đặt Phần Mềm

### Bước 1: Cài Mosquitto MQTT Broker (Windows)

```powershell
# Tải về từ: https://mosquitto.org/download/
# Cài đặt → Chạy như Windows Service

# Kiểm tra Mosquitto đang chạy:
sc query mosquitto

# Nếu chưa chạy:
net start mosquitto
```

**Hoặc chạy thủ công:**
```powershell
cd "C:\Program Files\mosquitto"
mosquitto.exe -v   # -v để xem log chi tiết
```

Tạo file cấu hình `C:\Program Files\mosquitto\mosquitto.conf`:
```
listener 1883
allow_anonymous true
```

### Bước 2: Cài Node.js

Tải về từ: https://nodejs.org/ (LTS version)

### Bước 3: Cài đặt Server

```powershell
cd d:\KHOA_LUAN_2026\du_an_web\server
npm install
```

### Bước 4: Khởi động Server

```powershell
cd d:\KHOA_LUAN_2026\du_an_web\server
npm start
```

Server sẽ chạy tại: **http://localhost:3000**

### Bước 5: Cài Arduino IDE cho ESP32

1. Cài [Arduino IDE 2.x](https://www.arduino.cc/en/software)
2. Thêm ESP32 board:
   - File → Preferences → Additional boards URL:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Tools → Board Manager → Tìm "esp32" → Install

4. Cài thư viện (Tools → Library Manager):
   - **PubSubClient** by Nick O'Leary
   - **ArduinoJson** by Benoit Blanchon

### Bước 6: Cấu hình & Nạp Firmware

Mở file `esp32/fertilizer_system/fertilizer_system.ino` trong Arduino IDE.

**Chỉnh sửa các thông số:**
```cpp
const char* WIFI_SSID     = "TEN_WIFI_CUA_BAN";    // WiFi SSID
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";         // WiFi Password
const char* MQTT_SERVER   = "192.168.1.100";          // IP máy tính chạy server
```

**Tìm IP của máy tính:**
```powershell
ipconfig
# Tìm dòng "IPv4 Address" trong mạng WiFi của bạn
```

**Chọn board và nạp:**
- Tools → Board → ESP32 Arduino → ESP32 Dev Module
- Tools → Port → Chọn COM port của ESP32
- Nhấn Upload (→)

---

## 🌐 Sử Dụng Web Dashboard

Truy cập: **http://localhost:3000** (hoặc `http://<IP-laptop>:3000` từ thiết bị khác)

### Giao diện chính:

1. **Header**: Trạng thái kết nối MQTT Broker và ESP32
2. **Cài Đặt Công Thức**: Nhập lượng N, P, K (mL) và tốc độ mở van
3. **Valve Cards (N, P, K)**: Hiển thị real-time lưu lượng, % hoàn thành, số bước motor
4. **Biểu đồ**: Lưu lượng (L/phút) theo thời gian thực
5. **Lịch Sử**: Ghi lại các phiên pha trộn

### Quy trình sử dụng:

```
1. Mở trình duyệt → http://localhost:3000
2. Kiểm tra: MQTT ✓ xanh, ESP32 ✓ xanh
3. Nhập tên công thức (VD: NPK 20-20-20)
4. Nhập lượng N, P, K cần pha (mL)
5. Điều chỉnh tốc độ mở van (%)
6. Nhấn "BẮT ĐẦU PHA TRỘN"
7. Quan sát: Van mở tuần tự N → P → K
8. Tự động dừng khi đạt đủ lượng
```

---

## 📡 Protocol MQTT

### Topics

| Topic | Hướng | Mô tả |
|-------|-------|-------|
| `fert/cmd` | Server → ESP32 | Gửi lệnh điều khiển |
| `fert/status` | ESP32 → Server | Gửi trạng thái (500ms/lần) |

### Format lệnh `fert/cmd`

```json
{
  "cmd": "start",
  "recipe": {
    "N": { "target_ml": 2000, "speed_percent": 60 },
    "P": { "target_ml": 2000, "speed_percent": 60 },
    "K": { "target_ml": 2000, "speed_percent": 60 }
  }
}
```

### Format trạng thái `fert/status`

```json
{
  "ts": 12345678,
  "running": true,
  "phase": 1,
  "valves": {
    "N": {
      "open": true,
      "steps": 200,
      "flow_lpm": 2.45,
      "volume_ml": 856,
      "target_ml": 2000,
      "percent": 42.8
    },
    "P": { "open": false, "steps": 0, "flow_lpm": 0, "volume_ml": 0, "target_ml": 2000, "percent": 0 },
    "K": { "open": false, "steps": 0, "flow_lpm": 0, "volume_ml": 0, "target_ml": 2000, "percent": 0 }
  },
  "total_target_ml": 6000,
  "total_volume_ml": 856,
  "wifi_rssi": -65
}
```

---

## 🔄 Quy Trình Hoạt Động

```
[Web] Nhập công thức → Nhấn BẮT ĐẦU
        ↓ HTTP POST /api/start
[Server] Tính toán → Publish MQTT fert/cmd
        ↓ MQTT
[ESP32] Nhận lệnh → Mở Van N (stepper motor)
        ↓
[YF-S201] Đếm xung → Tính thể tích
        ↓
[ESP32] So sánh với mục tiêu → Đạt đủ → Đóng Van N
        ↓
[ESP32] Mở Van P → ... → Mở Van K → ... → Hoàn thành
        ↓ MQTT (500ms)
[Server] Nhận status → Lưu DB → Gửi WebSocket
        ↓ Socket.io
[Web] Cập nhật real-time: flow rate, progress ring, chart
```

---

## 🛠️ Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| ESP32 không kết nối WiFi | Kiểm tra SSID/Password trong .ino |
| MQTT indicator đỏ | Kiểm tra Mosquitto đang chạy: `sc query mosquitto` |
| ESP32 indicator đỏ | - Kiểm tra IP MQTT_SERVER trong .ino<br>- ESP32 và laptop cùng mạng WiFi? |
| Van không mở | Kiểm tra chân EN_N/P/K, nguồn 12V cho driver |
| Flow sensor = 0 | Kiểm tra kết nối GPIO 25/26/27, nước có chảy? |
| Lượng bơm không chính xác | Hiệu chỉnh hằng số ML_PER_PULSE trong .ino |

### Hiệu chỉnh cảm biến YF-S201

Đặt lượng nước đã biết (VD: 1000 mL) vào bình đo chính xác, chạy hệ thống và xem trong Serial Monitor:
```
Số xung thực tế = ?
ML_PER_PULSE = 1000 / số_xung_thực_tế
```
Cập nhật giá trị `ML_PER_PULSE` trong file `.ino` và nạp lại.

---

## 📄 REST API Reference

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/status` | Trạng thái hệ thống |
| POST | `/api/start` | Bắt đầu pha trộn |
| POST | `/api/stop` | Dừng khẩn cấp |
| POST | `/api/home` | Về vị trí gốc |
| GET | `/api/history` | Lịch sử pha trộn |
| DELETE | `/api/history` | Xóa lịch sử |
| GET | `/api/recipes` | Danh sách công thức |
| POST | `/api/recipes` | Thêm công thức |
| DELETE | `/api/recipes/:id` | Xóa công thức |
