import re

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Thêm thư viện time.h nếu chưa có
if '#include <time.h>' not in code:
    code = code.replace('#include <WiFi.h>', '#include <WiFi.h>\n#include <time.h>')

# 2. Thêm hàm getRealTime()
func_getRealTime = """
String getRealTime() {
    struct tm timeinfo;
    if(!getLocalTime(&timeinfo, 10)){
        return String(millis());
    }
    char timeStringBuff[20];
    strftime(timeStringBuff, sizeof(timeStringBuff), "%H:%M:%S", &timeinfo);
    return String(timeStringBuff);
}
"""
if 'String getRealTime()' not in code:
    # Add it before the first function, e.g., before initPCNT
    code = code.replace('void initPCNT', func_getRealTime + '\nvoid initPCNT')

# 3. Cấu hình NTP trong setup() sau khi kết nối WiFi thành công
ntp_setup = """        Serial.printf("\\n[WiFi] ✓ Đã kết nối! IP: %s\\n", WiFi.localIP().toString().c_str());
        configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov"); // Cấu hình múi giờ GMT+7
        Serial.println("[NTP] Đang đồng bộ thời gian thực...");
"""
if 'configTime(7 * 3600' not in code:
    code = code.replace('Serial.printf("\\n[WiFi] ✓ Đã kết nối! IP: %s\\n", WiFi.localIP().toString().c_str());', ntp_setup)

# 4. Thay thế %lu và millis() thành %s và getRealTime().c_str()
# Cẩn thận chỉ thay thế những chỗ đang dùng [%lu] do tool Python trước tạo ra
code = re.sub(r'Serial\.printf\("\[%lu\]', r'Serial.printf("[%s]', code)
code = re.sub(r'Serial\.printf\("\[%s\](.*?)"\s*,\s*millis\(\)', r'Serial.printf("[%s]\1", getRealTime().c_str()', code)

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'w', encoding='utf-8') as f:
    f.write(code)

print("Realtime replacement completed!")
