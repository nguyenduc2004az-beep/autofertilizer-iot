// --- CODE TEST QUAY 1 VÒNG TỚI, 1 VÒNG LUI ---

#define STEP_PIN 16 
#define DIR_PIN 17

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
}

void loop() {
  // 1. CHỌN CHIỀU TIẾN
  digitalWrite(DIR_PIN, HIGH); 
  
  // Tạo vòng lặp xuất đúng 1600 xung (Tương đương 1 vòng)
  for(int i = 0; i < 1600; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(300);     // Độ trễ 300us cho tốc độ mượt mà
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(300);
  }
  
  // Dừng lại nghỉ 1 giây (1000 mili-giây)
  delay(1000); 
  
  // ==========================================
  
  // 2. CHỌN CHIỀU LÙI (Đảo trạng thái chân DIR)
  digitalWrite(DIR_PIN, LOW); 
  
  // Lại xuất đúng 1600 xung để lùi về vị trí cũ
  for(int i = 0; i < 1600; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(300);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(300);
  }
  
  // Dừng lại nghỉ 1 giây trước khi lặp lại toàn bộ quá trình
  delay(1000); 
}
