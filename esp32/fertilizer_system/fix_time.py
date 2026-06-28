import re

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'r', encoding='utf-8') as f:
    code = f.read()

code = re.sub(r'Serial\.printf\("\[%lu\] ", millis\(\), "(.*?)"', r'Serial.printf("[%lu] \1", millis()', code)

with open('d:/KHOA_LUAN_2026/du_an_web/esp32/fertilizer_system/fertilizer_system.ino', 'w', encoding='utf-8') as f:
    f.write(code)
print("Fixed!")
