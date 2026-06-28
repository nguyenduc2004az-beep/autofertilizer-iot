import re

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'r', encoding='utf-8') as f:
    code = f.read()

# Thay thế Serial.printf("..." -> Serial.printf("[%lu] ...", millis()
code = re.sub(r'Serial\.printf\(\s*\"', r'Serial.printf("[%lu] ", millis(), "', code)

# Thay thế Serial.println("...") -> Serial.printf("[%lu] ...\n", millis())
code = re.sub(r'Serial\.println\(\s*\"(.*?)\"\s*\)', r'Serial.printf("[%lu] \1\\n", millis())', code)

# Xóa các tham số millis() rác nếu chạy nhiều lần
code = re.sub(r'Serial\.printf\(\"\[%lu\] \", millis\(\), \"\[%lu\] \", millis\(\), ', r'Serial.printf("[%lu] ", millis(), ', code)
code = re.sub(r'Serial\.printf\(\"\[%lu\] \[%lu\] ', r'Serial.printf("[%lu] ', code)

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'w', encoding='utf-8') as f:
    f.write(code)
print("Done!")
